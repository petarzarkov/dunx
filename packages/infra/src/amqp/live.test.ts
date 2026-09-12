import {
  AppFactory,
  inject,
  Module,
  RequestContext,
  type App,
} from '@dunx/core';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Connection } from 'rabbitmq-client';
import { AmqpConnection } from './connection.js';
import { AmqpHandler } from './decorators.js';
import { AmqpModule } from './module.js';
import type { AmqpMessage } from './message.js';
import { defaultAmqpUrl } from './options.js';
import { AmqpPublisher } from './publisher.js';
import { AmqpRunner } from './runner.js';

const url = defaultAmqpUrl();

/**
 * The same shape the queue and redis suites use: CI has no broker for the `unit`
 * phase, so everything that needs one is conditional. `connectionTimeout` is short
 * and the connection is destroyed rather than closed, because `close()` on a
 * connection that never opened waits for the retry that is still pending.
 */
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
if (!live) {
  console.log(`[dunx] amqp integration tests skipped - ${url} unreachable`);
}

// A fresh namespace per run, so a leftover message can never make a test pass.
const ns = `dunx-test-${Bun.randomUUIDv7()}`;
const ORDERS = `${ns}.orders`;
const RETRIES = `${ns}.retries`;
const EXCHANGE = `${ns}.events`;

interface Recorded {
  readonly body: unknown;
  readonly routingKey: string;
  readonly traceId: string | undefined;
}

class Recorder {
  readonly handled: Recorded[] = [];
  readonly attempts: string[] = [];
  #resolve: (() => void) | undefined;
  #wanted = 0;

  /** Resolves once `count` deliveries have been recorded. */
  awaiting(count: number): Promise<void> {
    this.#wanted = count;
    if (this.handled.length >= count) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.#resolve = resolve;
    });
  }

  record(entry: Recorded): void {
    this.handled.push(entry);
    if (this.handled.length >= this.#wanted) this.#resolve?.();
  }
}

class OrdersConsumer {
  readonly recorder = inject(Recorder);
  readonly context = inject(RequestContext);

  @AmqpHandler({
    queue: ORDERS,
    exchange: EXCHANGE,
    routingKey: `${ns}.order.created`,
  })
  async onCreated(message: AmqpMessage<{ id: number }>): Promise<void> {
    this.recorder.record({
      body: message.body,
      routingKey: message.routingKey,
      traceId: this.context.getContext().traceId,
    });
  }

  /**
   * Throws on its first delivery. `requeue: false` sends it nowhere, which is what
   * makes the assertion "it was not redelivered" rather than "it was eventually".
   */
  @AmqpHandler({ queue: RETRIES, consumer: { requeue: false } })
  async onRetry(message: AmqpMessage<{ id: number }>): Promise<void> {
    this.recorder.attempts.push(`${message.body.id}`);
    throw new Error('always fails');
  }
}

@Module({
  imports: [AmqpModule.forRoot({ url, consume: true, connectionName: ns })],
  providers: [Recorder, OrdersConsumer],
})
class ConsumingModule {}

/** The publish side alone, which is what a web process imports. */
@Module({ imports: [AmqpModule.forRoot({ url, connectionName: `${ns}-web` })] })
class PublishingModule {}

/**
 * One app for the whole suite. Two containers consuming the same queue is how
 * AMQP spreads load, so booting per test would have the broker round-robin the
 * deliveries between them and half the assertions would wait forever.
 */
let app: App;

beforeAll(async () => {
  if (live) app = await AppFactory.create(ConsumingModule);
});

afterAll(async () => {
  await app?.shutdown();
});

describe.skipIf(!live)('an AMQP app against a real broker', () => {
  it('publishes, consumes and propagates the trace', async () => {
    const recorder = app.get(Recorder);
    const publisher = app.get(AmqpPublisher);
    const context = app.get(RequestContext);

    const traceId = 'a'.repeat(32);
    await context.runWithContext(
      { traceId, spanId: 'b'.repeat(16), traceFlags: '01' },
      async () => {
        await publisher.publish(
          { exchange: EXCHANGE, routingKey: `${ns}.order.created` },
          { id: 1 },
        );
      },
    );

    await recorder.awaiting(1);
    expect(recorder.handled).toHaveLength(1);
    expect(recorder.handled[0]?.body).toEqual({ id: 1 });
    expect(recorder.handled[0]?.routingKey).toBe(`${ns}.order.created`);
    // The whole reason `publish` exists rather than `publisher().send()`: the
    // consuming service continues the producer's trace instead of starting one.
    expect(recorder.handled[0]?.traceId).toBe(traceId);
  });

  it('drops a delivery whose handler throws when requeue is off', async () => {
    const recorder = app.get(Recorder);

    await app.get(AmqpPublisher).publish({ routingKey: RETRIES }, { id: 7 });
    // Two seconds of quiet is the assertion: a requeue would have redelivered
    // it within milliseconds, so a second attempt would be recorded by now.
    await Bun.sleep(1_000);
    expect(recorder.attempts).toEqual(['7']);
  });

  it('opens one consumer per handler', () => {
    expect(app.get(AmqpRunner).subscriber?.queues).toEqual([ORDERS, RETRIES]);
    expect(app.get(AmqpConnection).ready).toBe(true);
  });

  it('closes the connection when the container tears down', async () => {
    const solo = await AppFactory.create(PublishingModule);
    const connection = solo.get(AmqpConnection);
    await solo.get(AmqpPublisher).publish({ routingKey: `${ns}.unrouted` }, {});
    expect(connection.ready).toBe(true);

    await solo.shutdown();
    expect(connection.ready).toBe(false);
    expect(connection.opened).toBe(false);
  });
});
