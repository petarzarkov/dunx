import { spansOf, traced } from '../otel.fixture.js';
import {
  AppFactory,
  AsyncRequestContext,
  inject,
  NoopTracer,
  RequestContext,
  type App,
  type RequestFields,
} from '@dunx/core';
import { OtelModule, OtelTracer } from '@dunx/core/otel';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import type { Job, Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { redisReachable } from '../reachable.fixture.js';
import { defaultRedisUrl } from '../redis/options.js';
import { JobHandler } from './decorators.js';
import { JobDispatcher } from './dispatcher.js';
import type { DiscoveredJob } from './discover.js';
import { QueueModule } from './module.js';
import { JobPublisher } from './publisher.js';
import { QueueRunner } from './runner.js';
import { JobTracing } from './tracing.js';
import {
  PREFIX,
  SANDBOXED,
  sandboxedModule,
  type Witness,
} from './tracing.fixture.js';
import { WorkerFactory, type WorkerApp } from './worker.js';

const SPAN = 'b'.repeat(16);
const hex = (bytes: number): string =>
  crypto.getRandomValues(new Uint8Array(bytes)).toHex();

const only = (spans: readonly ReadableSpan[]): ReadableSpan => {
  expect(spans).toHaveLength(1);
  return spans[0] as ReadableSpan;
};

const fakeJob = (metadata?: string): Job =>
  ({
    id: '7',
    queueName: 'emails',
    name: 'welcome',
    opts: metadata === undefined ? {} : { telemetry: { metadata } },
  }) as unknown as Job;

const dispatchWith = async (
  tracing: JobTracing | undefined,
  job: Job,
  fail = false,
  context = new AsyncRequestContext(),
): Promise<RequestFields> => {
  let fields: RequestFields = {};
  const found: DiscoveredJob = {
    queue: 'emails',
    name: 'welcome',
    provider: 'Emails',
    method: 'welcome',
    handler: () => {
      fields = context.getContext();
      if (fail) throw new Error('handler exploded');
    },
  };
  const dispatcher = new JobDispatcher([found], undefined, undefined, tracing);
  try {
    await dispatcher.dispatch(job);
  } catch {
    // The span is what these tests read.
  }
  return fields;
};

describe('JobTracing', () => {
  it('is absent for the no-op tracer, so nothing on the hot path changes', () => {
    expect(
      JobTracing.of(new NoopTracer(), new AsyncRequestContext()),
    ).toBeUndefined();
  });

  it('opens a CONSUMER span parented to the carried traceparent', async () => {
    const traceId = hex(16);
    const context = new AsyncRequestContext();
    const fields = await dispatchWith(
      JobTracing.of(new OtelTracer(), context),
      fakeJob(
        JSON.stringify({
          traceparent: `00-${traceId}-${SPAN}-01`,
          tracestate: 'v=1',
        }),
      ),
      false,
      context,
    );

    const span = only(spansOf(traceId));
    expect(span.name).toBe('process emails');
    expect(span.kind).toBe(SpanKind.CONSUMER);
    expect(span.parentSpanContext?.spanId).toBe(SPAN);
    expect(span.attributes).toEqual({
      'messaging.system': 'bullmq',
      'messaging.operation.type': 'process',
      'messaging.operation.name': 'process',
      'messaging.destination.name': 'emails',
      'messaging.message.id': '7',
      'bullmq.job.name': 'welcome',
    });
    expect(fields).toEqual({
      flow: 'job',
      event: 'emails',
      context: 'Emails.welcome',
      traceId,
      spanId: span.spanContext().spanId,
      parentSpanId: SPAN,
      traceFlags: '01',
      traceState: 'v=1',
    });
  });

  /** `tracestate` is carried only beside the trace it belongs to. */
  it('carries the scope tracestate only when the scope is on the span trace', async () => {
    const context = new AsyncRequestContext();
    const tracing = JobTracing.of(new OtelTracer(), context) as JobTracing;
    const carried = async (sameTrace: boolean): Promise<unknown> => {
      let metadata: string | undefined;
      await traced(() =>
        context.runWithContext(
          {
            traceId: sameTrace
              ? (trace.getActiveSpan()?.spanContext().traceId as string)
              : hex(16),
            spanId: SPAN,
            traceState: 'v=1',
          },
          () =>
            tracing.publish('emails', 'welcome', undefined, (options) => {
              metadata = options?.telemetry?.metadata;
              return Promise.resolve({ id: '1' } as Job);
            }),
        ),
      );
      return JSON.parse(metadata as string);
    };

    expect(await carried(true)).toMatchObject({ tracestate: 'v=1' });
    expect(await carried(false)).not.toHaveProperty('tracestate');
  });

  it('starts a trace for a job carrying no metadata, or metadata it cannot read', async () => {
    for (const metadata of [undefined, 'not json', '{"traceparent":"00-x"}']) {
      const context = new AsyncRequestContext();
      const fields = await dispatchWith(
        JobTracing.of(new OtelTracer(), context),
        fakeJob(metadata),
        false,
        context,
      );
      const span = only(spansOf(fields.traceId as string));
      expect(span.parentSpanContext).toBeUndefined();
      expect(fields.spanId).toBe(span.spanContext().spanId);
      expect(fields.parentSpanId).toBeUndefined();
    }
  });

  it('marks the span failed when the handler throws', async () => {
    const context = new AsyncRequestContext();
    const fields = await dispatchWith(
      JobTracing.of(new OtelTracer(), context),
      fakeJob(),
      true,
      context,
    );
    const span = only(spansOf(fields.traceId as string));
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('leaves the handler outside any scope with the no-op tracer', async () => {
    const fields = await dispatchWith(
      JobTracing.of(new NoopTracer(), new AsyncRequestContext()),
      fakeJob(JSON.stringify({ traceparent: `00-${hex(16)}-${SPAN}-01` })),
    );
    expect(fields).toEqual({});
  });
});

const url = defaultRedisUrl();
const live = await redisReachable(url);
const INLINE = `${PREFIX}-inline`;
const CONSUMED = `${PREFIX}-consumed`;

class Inline {
  readonly context = inject(RequestContext);

  @JobHandler({ queue: INLINE, name: 'witness' })
  witness(): RequestFields {
    return this.context.getContext();
  }
}

class Consumed {
  @JobHandler({ queue: CONSUMED, name: 'witness' })
  consumed(): void {
    // The span is the witness.
  }
}

class Root {}

const until = async <T>(
  read: () => Promise<T | undefined> | T | undefined,
  what: string,
  timeoutMs = 10_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const finished = (queue: Queue, id: string): Promise<Job> =>
  until(async () => {
    const job = await queue.getJob(id);
    return job?.finishedOn === undefined ? undefined : job;
  }, `job ${id} to finish`);

const consumerOf = (traceId: string): Promise<ReadableSpan> =>
  until(
    () => spansOf(traceId).find((span) => span.kind === SpanKind.CONSUMER),
    'the consumer span',
  );

/** Publishes inside a fresh root span and returns the producer span. */
const produce = async (
  publisher: JobPublisher,
  queue: string,
): Promise<{ producer: ReadableSpan; job: Job }> => {
  let job: Job | undefined;
  const spans = await traced(async () => {
    job = await publisher.publish(queue, 'witness', { to: 'ada' });
  });
  return {
    producer: only(spans.filter((span) => span.kind === SpanKind.PRODUCER)),
    job: job as Job,
  };
};

describe.if(live)('queue spans against a live server', () => {
  let worker: WorkerApp;
  let publisher: JobPublisher;

  beforeAll(async () => {
    worker = await WorkerFactory.create({
      module: Root,
      imports: [OtelModule, QueueModule.forRoot({ url, prefix: PREFIX })],
      providers: [Inline],
    });
    await worker.start();
    publisher = worker.get(JobPublisher);
  });

  afterAll(async () => {
    await publisher.queue(INLINE).obliterate({ force: true });
    await worker.shutdown();
  });

  it('opens a PRODUCER span under the active one and carries it in telemetry metadata', async () => {
    const { producer, job } = await produce(publisher, INLINE);
    const { traceId, spanId } = producer.spanContext();

    expect(producer.name).toBe('publish ' + INLINE);
    expect(producer.kind).toBe(SpanKind.PRODUCER);
    expect(producer.attributes).toEqual({
      'messaging.system': 'bullmq',
      'messaging.operation.type': 'send',
      'messaging.operation.name': 'publish',
      'messaging.destination.name': INLINE,
      'bullmq.job.name': 'witness',
      'messaging.message.id': job.id as string,
    });
    const stored = await publisher.queue(INLINE).getJob(job.id as string);
    expect(stored?.opts.telemetry?.metadata).toBe(
      JSON.stringify({ traceparent: `00-${traceId}-${spanId}-01` }),
    );
    expect(stored?.data).toEqual({ to: 'ada' });
  });

  it('parents the inline consumer span to the producer, and logs under it', async () => {
    const { producer, job } = await produce(publisher, INLINE);
    const { traceId, spanId } = producer.spanContext();

    const consumer = await consumerOf(traceId);
    expect(consumer.parentSpanContext?.spanId).toBe(spanId);
    const done = await finished(publisher.queue(INLINE), job.id as string);
    expect(done.returnvalue).toMatchObject({
      flow: 'job',
      traceId,
      spanId: consumer.spanContext().spanId,
      parentSpanId: spanId,
    });
  });

  it('keeps metadata the caller set, and honours omitContext', async () => {
    const own = JSON.stringify({ traceparent: `00-${hex(16)}-${SPAN}-01` });
    const queue = publisher.queue(INLINE);
    await traced(async () => {
      const kept = await publisher.publish(
        INLINE,
        'witness',
        {},
        {
          telemetry: { metadata: own },
        },
      );
      const omitted = await publisher.publish(
        INLINE,
        'witness',
        {},
        {
          telemetry: { omitContext: true },
        },
      );
      expect((await queue.getJob(kept.id as string))?.opts.telemetry).toEqual({
        metadata: own,
      });
      expect(
        (await queue.getJob(omitted.id as string))?.opts.telemetry?.metadata,
      ).toBeUndefined();
    });
  });

  it('parents the consumer span in a forked child to the producer', async () => {
    const forking = await WorkerFactory.create(
      sandboxedModule(
        new URL('./tracing.processor.fixture.ts', import.meta.url).pathname,
      ),
    );
    await forking.start();
    const sandboxed = forking.get(JobPublisher);
    try {
      const { producer, job } = await produce(sandboxed, SANDBOXED);
      const { traceId, spanId } = producer.spanContext();
      const done = await finished(sandboxed.queue(SANDBOXED), job.id as string);
      const witness = done.returnvalue as Witness;

      expect(witness.pid).not.toBe(process.pid);
      expect(witness.span).toEqual({
        name: `process ${SANDBOXED}`,
        traceId,
        spanId: witness.fields['spanId'] as string,
        parentSpanId: spanId,
      });
      expect(witness.fields).toMatchObject({ traceId, parentSpanId: spanId });
    } finally {
      await sandboxed.queue(SANDBOXED).obliterate({ force: true });
      await forking.shutdown();
    }
  }, 30_000);

  it('opens the same span under consume: true', async () => {
    const app: App = await AppFactory.create({
      module: Root,
      imports: [
        OtelModule,
        QueueModule.forRoot({ url, prefix: PREFIX, consume: true }),
      ],
      providers: [Consumed],
    });
    const own = app.get(JobPublisher);
    try {
      expect(app.get(QueueRunner).consumer).toBeDefined();
      const { producer } = await produce(own, CONSUMED);
      const { traceId, spanId } = producer.spanContext();
      const consumer = await consumerOf(traceId);
      expect(consumer.parentSpanContext?.spanId).toBe(spanId);
    } finally {
      await own.queue(CONSUMED).obliterate({ force: true });
      await app.shutdown();
    }
  });

  it('adds no telemetry to a job published with the no-op tracer', async () => {
    const plain = await AppFactory.create({
      module: Root,
      imports: [QueueModule.forRoot({ url, prefix: PREFIX })],
    });
    const own = plain.get(JobPublisher);
    try {
      let job: Job | undefined;
      await traced(async () => {
        job = await own.publish(`${PREFIX}-plain`, 'witness', {});
      });
      const stored = await own.queue(`${PREFIX}-plain`).getJob(job?.id ?? '');
      expect(stored?.opts.telemetry).toBeUndefined();
    } finally {
      await own.queue(`${PREFIX}-plain`).obliterate({ force: true });
      await plain.shutdown();
    }
  });
});
