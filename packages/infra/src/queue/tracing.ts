import {
  formatTraceparent,
  NoopTracer,
  RequestContext,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  Tracer,
  type RemoteParent,
  type ScopedResolver,
} from '@dunx/core';
import type { Job, JobsOptions } from 'bullmq';
import { remoteParentOf, traceStateFor } from '../trace-carrier.js';
import type { DiscoveredJob } from './discover.js';

/**
 * The trace a job carries, read back from bullmq's `opts.telemetry.metadata`.
 * The carrier is the JSON object `bullmq-otel` writes there, so a job crosses
 * between a dunx app and one on bullmq's own telemetry with its parent intact.
 */
const parentOf = (job: Job): RemoteParent | undefined => {
  const metadata = job.opts?.telemetry?.metadata;
  if (metadata === undefined) return undefined;
  let carrier: unknown;
  try {
    carrier = JSON.parse(metadata);
  } catch {
    return undefined;
  }
  if (typeof carrier !== 'object' || carrier === null) return undefined;
  return remoteParentOf(carrier as Record<string, unknown>);
};

/**
 * A PRODUCER span around each publish and a CONSUMER span around each handler,
 * joined through the job's telemetry metadata rather than its payload.
 *
 * Not bullmq's own `telemetry` option: that adapter wants a span handle to start
 * and end by hand, where `Tracer` runs a callback, and it opens the process span
 * in the parent process, so a forked handler would not run inside it. The
 * metadata travels with `job.opts` into the fork, where `JobProcessor` reads it.
 */
export class JobTracing {
  readonly #tracer: Tracer;
  readonly #context: RequestContext;

  /** Absent for the no-op tracer, which leaves every job exactly as it was. */
  static of(tracer: Tracer, context: RequestContext): JobTracing | undefined {
    return tracer instanceof NoopTracer
      ? undefined
      : new JobTracing(tracer, context);
  }

  static in(app: ScopedResolver): JobTracing | undefined {
    return JobTracing.of(app.get(Tracer), app.get(RequestContext));
  }

  private constructor(tracer: Tracer, context: RequestContext) {
    this.#tracer = tracer;
    this.#context = context;
  }

  /**
   * `add` inside a PRODUCER span, handed options carrying the span when it
   * records. Metadata the caller set, or `omitContext`, is left as it is.
   */
  publish<J extends Job>(
    queue: string,
    name: string,
    options: JobsOptions | undefined,
    add: (options: JobsOptions | undefined) => Promise<J>,
  ): Promise<J> {
    return this.#tracer.span(
      `publish ${queue}`,
      {
        kind: 'producer',
        attributes: {
          'messaging.system': 'bullmq',
          'messaging.operation.type': 'send',
          'messaging.operation.name': 'publish',
          'messaging.destination.name': queue,
          'bullmq.job.name': name,
        },
      },
      async (span) => {
        const ids = span.ids();
        const telemetry = options?.telemetry;
        const carried =
          ids === undefined ||
          telemetry?.metadata !== undefined ||
          telemetry?.omitContext === true;
        const state = carried
          ? undefined
          : traceStateFor(ids, this.#context.getContext());
        const job = await add(
          carried
            ? options
            : {
                ...options,
                telemetry: {
                  ...telemetry,
                  metadata: JSON.stringify({
                    [TRACEPARENT_HEADER]: formatTraceparent(ids),
                    ...(state === undefined
                      ? {}
                      : { [TRACESTATE_HEADER]: state }),
                  }),
                },
              },
        );
        if (job.id !== undefined) {
          span.setAttribute('messaging.message.id', job.id);
        }
        return job;
      },
    );
  }

  /**
   * `run` inside a CONSUMER span parented to the job's metadata. A recording
   * span's ids go into a scope of the job's own, so its log lines join the span.
   */
  process<T>(job: Job, found: DiscoveredJob, run: () => T): T {
    const parent = parentOf(job);
    return this.#tracer.span(
      `process ${job.queueName}`,
      {
        kind: 'consumer',
        attributes: {
          'messaging.system': 'bullmq',
          'messaging.operation.type': 'process',
          'messaging.operation.name': 'process',
          'messaging.destination.name': job.queueName,
          ...(job.id === undefined ? {} : { 'messaging.message.id': job.id }),
          'bullmq.job.name': job.name,
        },
        ...(parent === undefined ? {} : { parent }),
      },
      (span) => {
        const ids = span.ids();
        if (ids === undefined) return run();
        return this.#context.runWithContext(
          {
            flow: 'job',
            event: job.queueName,
            context: `${found.provider}.${found.method}`,
            traceId: ids.traceId,
            spanId: ids.spanId,
            ...(parent === undefined ? {} : { parentSpanId: parent.spanId }),
            traceFlags: ids.flags,
            ...(parent?.state === undefined
              ? {}
              : { traceState: parent.state }),
          },
          run,
          // A job runs off the worker's blocking read, not inside a request.
          { inherit: false },
        );
      },
    );
  }
}
