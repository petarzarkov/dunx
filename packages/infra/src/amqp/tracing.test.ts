import { spansOf, traced } from '../otel.fixture.js';
import {
  AppFactory,
  AsyncRequestContext,
  ConsoleLogger,
  inject,
  Module,
  NoopTracer,
  RequestContext,
  type App,
  type RequestFields,
  type Tracer,
} from '@dunx/core';
import { OtelModule, OtelTracer } from '@dunx/core/otel';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-node';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  Connection,
  ConsumerStatus,
  type AsyncMessage,
  type Envelope,
  type Publisher,
} from 'rabbitmq-client';
import type { AmqpConnection } from './connection.js';
import { AmqpHandler } from './decorators.js';
import { AmqpDispatcher } from './dispatcher.js';
import type { DiscoveredSubscription } from './discover.js';
import type { AmqpMessage } from './message.js';
import { AmqpModule } from './module.js';
import { AmqpOptions, defaultAmqpUrl } from './options.js';
import { AmqpPublisher } from './publisher.js';

const TRACE = 'a'.repeat(32);
const SPAN = 'b'.repeat(16);
const quiet = new ConsoleLogger(undefined, 'fatal');

const publisherWith = (
  tracer: Tracer | undefined,
  context = new AsyncRequestContext(),
  options: { neverSends?: boolean } = {},
) => {
  const sent: Envelope[] = [];
  const fake = {
    send: (envelope: Envelope) => {
      sent.push(envelope);
      return options.neverSends
        ? new Promise<void>(() => undefined)
        : Promise.resolve();
    },
    on: () => fake,
  };
  const connection = {
    createPublisher: () => fake as unknown as Publisher,
  } as unknown as AmqpConnection;
  const publisher = new AmqpPublisher(
    connection,
    new AmqpOptions({ url: 'amqp://127.0.0.1:1', publishTimeoutMs: 20 }),
    quiet,
    context,
    tracer,
  );
  return { publisher, sent, context };
};

const only = (spans: readonly ReadableSpan[]): ReadableSpan => {
  expect(spans).toHaveLength(1);
  return spans[0] as ReadableSpan;
};

describe('AmqpPublisher with a recording tracer', () => {
  it('opens a PRODUCER span under the active one and stamps its ids', async () => {
    const { publisher, sent } = publisherWith(new OtelTracer());
    const spans = await traced(() =>
      publisher.publish({ exchange: 'shop', routingKey: 'order.created' }, {}),
    );

    const span = only(spans);
    expect(span.name).toBe('publish shop');
    expect(span.kind).toBe(SpanKind.PRODUCER);
    expect(span.attributes).toEqual({
      'messaging.system': 'rabbitmq',
      'messaging.operation.type': 'send',
      'messaging.operation.name': 'publish',
      'messaging.destination.name': 'shop',
      'messaging.rabbitmq.destination.routing_key': 'order.created',
    });
    const { traceId, spanId } = span.spanContext();
    expect(sent[0]?.headers?.['traceparent']).toBe(
      `00-${traceId}-${spanId}-01`,
    );
  });

  it('names the default exchange by its routing key and keeps tracestate', async () => {
    const { publisher, sent, context } = publisherWith(new OtelTracer());
    const spans = await traced(() =>
      context.runWithContext(
        { traceId: TRACE, spanId: SPAN, traceFlags: '01', traceState: 'v=1' },
        () => publisher.publish('orders', {}),
      ),
    );

    expect(only(spans).name).toBe('publish orders');
    expect(sent[0]?.headers?.['tracestate']).toBe('v=1');
  });

  it('leaves a caller-set traceparent alone', async () => {
    const { publisher, sent } = publisherWith(new OtelTracer());
    const forwarded = `00-${TRACE}-${SPAN}-01`;
    await traced(() =>
      publisher.publish(
        { routingKey: 'orders', headers: { traceparent: forwarded } },
        {},
      ),
    );
    expect(sent[0]?.headers).toEqual({ traceparent: forwarded });
  });

  it('marks the span failed when the publish does not confirm', async () => {
    const { publisher } = publisherWith(new OtelTracer(), undefined, {
      neverSends: true,
    });
    const spans = await traced(() => publisher.publish('orders', {}));
    expect(only(spans).status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('AmqpPublisher with the no-op tracer', () => {
  it('stamps exactly what it stamps with no tracer at all', async () => {
    const fields: RequestFields = {
      traceId: TRACE,
      spanId: SPAN,
      traceFlags: '00',
      traceState: 'v=1',
    };
    const plain = publisherWith(undefined);
    const noop = publisherWith(new NoopTracer());
    for (const { publisher, context } of [plain, noop]) {
      await context.runWithContext(fields, () =>
        publisher.publish({ exchange: 'shop', routingKey: 'k' }, {}),
      );
      await publisher.publish('bare', {});
    }
    expect(noop.sent).toEqual(plain.sent);
    expect(plain.sent[0]?.headers).toEqual({
      traceparent: `00-${TRACE}-${SPAN}-00`,
      tracestate: 'v=1',
    });
    expect(plain.sent[1]?.headers).toBeUndefined();
  });
});

const delivery = (headers?: Record<string, unknown>): AsyncMessage =>
  ({
    body: {},
    consumerTag: 'ct',
    deliveryTag: 1,
    exchange: '',
    redelivered: false,
    routingKey: 'orders',
    messageId: 'm-1',
    ...(headers === undefined ? {} : { headers }),
  }) as AsyncMessage;

const dispatch = async (
  tracer: Tracer | undefined,
  message: AsyncMessage,
  fail = false,
): Promise<{ fields: RequestFields; status: ConsumerStatus }> => {
  const context = new AsyncRequestContext();
  let fields: RequestFields = {};
  const found: DiscoveredSubscription = {
    queue: 'orders',
    provider: 'Orders',
    method: 'onOrder',
    handler: () => {
      fields = context.getContext();
      if (fail) throw new Error('handler exploded');
    },
  };
  const status = await new AmqpDispatcher(quiet, context, tracer).dispatch(
    found,
    { requeue: false, timeoutMs: undefined },
    message,
  );
  return { fields, status };
};

describe('AmqpDispatcher with a recording tracer', () => {
  it('opens a CONSUMER span parented to the traceparent and logs under it', async () => {
    const traceId = crypto.getRandomValues(new Uint8Array(16)).toHex();
    const { fields } = await dispatch(
      new OtelTracer(),
      delivery({ traceparent: `00-${traceId}-${SPAN}-01`, tracestate: 'v=1' }),
    );

    const span = only(spansOf(traceId));
    expect(span.name).toBe('process orders');
    expect(span.kind).toBe(SpanKind.CONSUMER);
    expect(span.parentSpanContext?.spanId).toBe(SPAN);
    expect(span.attributes).toEqual({
      'messaging.system': 'rabbitmq',
      'messaging.operation.type': 'process',
      'messaging.operation.name': 'process',
      'messaging.destination.name': 'orders',
      'messaging.message.id': 'm-1',
    });
    expect(fields).toMatchObject({
      flow: 'amqp',
      traceId,
      spanId: span.spanContext().spanId,
      parentSpanId: SPAN,
      traceFlags: '01',
      traceState: 'v=1',
    });
  });

  it('starts a trace of its own for a message that carries none', async () => {
    const { fields } = await dispatch(new OtelTracer(), delivery());
    const span = only(spansOf(fields.traceId as string));
    expect(span.parentSpanContext).toBeUndefined();
    expect(fields.spanId).toBe(span.spanContext().spanId);
    expect(fields.parentSpanId).toBeUndefined();
  });

  it('marks the span failed when the handler throws, and still settles', async () => {
    const { fields, status } = await dispatch(
      new OtelTracer(),
      delivery(),
      true,
    );
    expect(status).toBe(ConsumerStatus.DROP);
    const span = only(spansOf(fields.traceId as string));
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });
});

describe('AmqpDispatcher with the no-op tracer', () => {
  it('continues the header with a minted span, as it always has', async () => {
    const { fields } = await dispatch(
      new NoopTracer(),
      delivery({ traceparent: `00-${TRACE}-${SPAN}-01` }),
    );
    expect(fields.traceId).toBe(TRACE);
    expect(fields.parentSpanId).toBe(SPAN);
    expect(fields.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(spansOf(TRACE)).toEqual([]);
  });
});

const url = defaultAmqpUrl();
const reachable = async (): Promise<boolean> => {
  const probe = new Connection({ url, connectionTimeout: 500, retryLow: 50 });
  probe.on('error', () => undefined);
  try {
    await probe.onConnect(2_000, true);
    return true;
  } catch {
    return false;
  } finally {
    probe.unsafeDestroy();
  }
};
const live = await reachable();
const ns = `dunx-otel-${Bun.randomUUIDv7()}`;

class Seen {
  readonly fields: RequestFields[] = [];
}

class Traced {
  readonly seen = inject(Seen);
  readonly context = inject(RequestContext);

  @AmqpHandler({ queue: `${ns}.traced` })
  onMessage(_message: AmqpMessage): void {
    this.seen.fields.push(this.context.getContext());
  }
}

@Module({
  imports: [
    OtelModule,
    AmqpModule.forRoot({ url, consume: true, connectionName: ns }),
  ],
  providers: [Seen, Traced],
})
class TracedModule {}

describe.skipIf(!live)('AMQP spans against a real broker', () => {
  let app: App;

  beforeAll(async () => {
    app = await AppFactory.create(TracedModule);
  });

  afterAll(async () => {
    await app?.shutdown();
  });

  it('parents the consumer span to the producer span across the broker', async () => {
    const seen = app.get(Seen);
    const produced = await traced(() =>
      app.get(AmqpPublisher).publish(`${ns}.traced`, {}),
    );
    const producer = only(produced);
    const { traceId, spanId } = producer.spanContext();

    const consumed = (): ReadableSpan | undefined =>
      spansOf(traceId).find((span) => span.kind === SpanKind.CONSUMER);
    const deadline = Date.now() + 5_000;
    while (consumed() === undefined && Date.now() < deadline) {
      await Bun.sleep(10);
    }
    const consumer = consumed();
    expect(consumer?.parentSpanContext?.spanId).toBe(spanId);
    expect(seen.fields[0]).toMatchObject({
      traceId,
      spanId: consumer?.spanContext().spanId,
      parentSpanId: spanId,
    });
  });
});
