import {
  AppFactory,
  ConsoleLogger,
  Logger,
  Module,
  provide,
  type App,
} from '@dunx/core';
import { afterEach, describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { Consumer } from 'rabbitmq-client';
import { AmqpConnection } from './connection.js';
import { AmqpHandler } from './decorators.js';
import type { DiscoveredSubscription } from './discover.js';
import { AmqpModule } from './module.js';
import { AmqpSubscriber, consumerProps } from './subscriber.js';

/** A port nothing answers on, so every setup attempt fails the same way. */
const unreachable = 'amqp://127.0.0.1:1';

const subscription = (
  over: Partial<DiscoveredSubscription> = {},
): DiscoveredSubscription => ({
  queue: 'orders',
  provider: 'Orders',
  method: 'onOrder',
  handler: () => undefined,
  ...over,
});

describe('consumerProps', () => {
  it('puts the handler meta over the module defaults', () => {
    const props = consumerProps(
      { concurrency: 8, qos: { prefetchCount: 16 } },
      subscription({ consumer: { concurrency: 1 } }),
    );
    expect(props.queue).toBe('orders');
    expect(props.concurrency).toBe(1);
    expect(props.qos?.prefetchCount).toBe(16);
  });

  it('declares and binds the convenience exchange', () => {
    const props = consumerProps(
      {},
      subscription({ exchange: 'shop', routingKey: 'order.created' }),
    );
    expect(props.exchanges).toEqual([
      { exchange: 'shop', type: 'topic', durable: true },
    ]);
    expect(props.queueBindings).toEqual([
      { exchange: 'shop', queue: 'orders', routingKey: 'order.created' },
    ]);
  });

  it('routes on the queue name when no key is given', () => {
    const props = consumerProps({}, subscription({ exchange: 'shop' }));
    expect(props.queueBindings?.[0]?.routingKey).toBe('orders');
  });

  it('honours a non-default exchange type', () => {
    const props = consumerProps(
      {},
      subscription({ exchange: 'shop', exchangeType: 'fanout' }),
    );
    expect(props.exchanges?.[0]?.type).toBe('fanout');
  });

  /** Appended rather than replacing, so the pair plus a hand-written binding
   * gives both rather than silently dropping one. */
  it('appends to bindings the handler declared itself', () => {
    const props = consumerProps(
      {},
      subscription({
        exchange: 'shop',
        consumer: {
          exchanges: [{ exchange: 'audit', type: 'fanout' }],
          queueBindings: [{ exchange: 'audit', queue: 'orders' }],
        },
      }),
    );
    expect(props.exchanges).toHaveLength(2);
    expect(props.queueBindings).toHaveLength(2);
  });

  it('declares nothing when the handler names no exchange', () => {
    const props = consumerProps({}, subscription());
    expect(props.exchanges).toBeUndefined();
    expect(props.queueBindings).toBeUndefined();
  });
});

describe('a subscriber whose broker is unreachable', () => {
  let app: App | undefined;

  afterEach(async () => {
    await app?.shutdown();
    app = undefined;
  });

  const boot = async (): Promise<{ app: App; lines: unknown[] }> => {
    const lines: unknown[] = [];
    const logger = new ConsoleLogger(undefined, 'fatal');
    for (const level of ['info', 'error'] as const) {
      logger[level] = (message: unknown): void => {
        lines.push(message);
      };
    }

    class Orders {
      @AmqpHandler({ queue: 'orders' })
      onOrder(): string {
        return 'handled';
      }
    }

    @Module({
      imports: [
        AmqpModule.forRoot({
          url: unreachable,
          readyTimeoutMs: 50,
          drainTimeoutMs: 50,
        }),
      ],
      providers: [Orders, provide(Logger, { useValue: logger })],
    })
    class Root {}

    app = await AppFactory.create(Root);
    return { app, lines };
  };

  /**
   * A broker that is down degrades; it does not fail boot. This container is
   * usually also serving HTTP, and refusing to start the web tier because a
   * broker is unreachable trades a partial outage for a total one.
   */
  it('starts, says it is not consuming, and stops cleanly', async () => {
    const { app: booted, lines } = await boot();
    const subscriber = new AmqpSubscriber(booted, [subscription()]);

    expect(await subscriber.start()).toEqual(['orders']);
    expect(lines.join('\n')).toContain('is not set up yet');

    // `Consumer.close()` waits `acquireTimeout` - 20 s by default - when the
    // connection is down, with nothing in flight to drain. Bounded, or every
    // SIGTERM against an absent broker would sit there.
    const started = Bun.nanoseconds();
    await subscriber.stop();
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(3_000);
    // Idempotent: the runner's onShutdown may run after an explicit stop.
    await subscriber.stop();
  });

  /** A channel opened for the first subscription and left out of the teardown is
   * a channel nothing closes. */
  it('closes what it opened when a later consumer cannot be created', async () => {
    const { app: booted } = await boot();
    const connection = booted.get(AmqpConnection);
    // The second call fails, so the first consumer is already open.
    let calls = 0;
    const create = connection.createConsumer.bind(connection);
    connection.createConsumer = (props, handler) => {
      calls += 1;
      if (calls > 1) throw new Error('channel refused');
      return create(props, handler);
    };

    const subscriber = new AmqpSubscriber(booted, [
      subscription(),
      subscription({ queue: 'audit' }),
    ]);

    await expect(subscriber.start()).rejects.toThrow('channel refused');
    // Idempotent, and already drained by the failure path.
    await subscriber.stop();
    expect(calls).toBe(2);
  });

  it('refuses a second start, since it is one consumer per queue per process', async () => {
    const { app: booted } = await boot();
    const subscriber = new AmqpSubscriber(booted, [subscription()]);

    await subscriber.start();
    await expect(subscriber.start()).rejects.toThrow(/already run/);
    await subscriber.stop();
  });
});

/**
 * A fake `AmqpConnection`, so the paths a real broker cannot be made to take on
 * demand - a consumer that reports an error, one that never drains - are reached
 * without waiting on a socket.
 */
class FakeConsumer extends EventEmitter {
  readonly queue = 'orders';
  closed = 0;
  neverCloses = false;

  close(): Promise<void> {
    this.closed++;
    // Never settling is the point: `Consumer.close()` waits `acquireTimeout`
    // when the connection is down, which is what the drain bound is for.
    return this.neverCloses
      ? new Promise<void>(() => undefined)
      : Promise.resolve();
  }
}

describe('a subscriber over a connection that misbehaves', () => {
  let app: App | undefined;

  afterEach(async () => {
    await app?.shutdown();
    app = undefined;
  });

  const boot = async (): Promise<{
    subscriber: AmqpSubscriber;
    consumer: FakeConsumer;
    lines: { level: string; message: unknown }[];
  }> => {
    const lines: { level: string; message: unknown }[] = [];
    const logger = new ConsoleLogger(undefined, 'fatal');
    for (const level of ['info', 'warn', 'error'] as const) {
      logger[level] = (message: unknown): void => {
        // The container warns that this module rebinds AmqpConnection, which is
        // the point of the fake and not what any of these assert on.
        if (!String(message).includes('AmqpConnection, which module')) {
          lines.push({ level, message });
        }
      };
    }

    const consumer = new FakeConsumer();
    const connection = {
      createConsumer: () => consumer as unknown as Consumer,
    } as unknown as AmqpConnection;

    @Module({
      imports: [
        AmqpModule.forRoot({
          url: unreachable,
          readyTimeoutMs: 50,
          drainTimeoutMs: 50,
        }),
      ],
      providers: [
        provide(Logger, { useValue: logger }),
        provide(AmqpConnection, { useValue: connection }),
      ],
    })
    class Root {}

    app = await AppFactory.create(Root);
    return {
      subscriber: new AmqpSubscriber(app, [subscription()]),
      consumer,
      lines,
    };
  };

  it('says which queue is consuming once its consumer reports ready', async () => {
    const { subscriber, consumer, lines } = await boot();
    const started = subscriber.start();
    consumer.emit('ready');

    await started;
    expect(lines[0]?.message).toContain(
      'Started AMQP consumer for queue: orders',
    );
    await subscriber.stop();
  });

  /**
   * Throttled, not deduplicated: a broker that is down fails every setup attempt
   * on its own backoff, and each one emits. A later outage still gets reported.
   */
  it('reports a consumer error once per interval', async () => {
    const { subscriber, consumer, lines } = await boot();
    const started = subscriber.start();
    consumer.emit('ready');
    await started;

    consumer.emit('error', new Error('channel closed'));
    consumer.emit('error', new Error('channel closed again'));

    const errors = lines.filter((line) => line.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toContain('AMQP consumer error on orders');
    await subscriber.stop();
  });

  /** One consumer that will not close must not stop the rest of teardown, which
   * is what closes the socket under it. */
  it('gives up on a consumer that will not drain, and says so', async () => {
    const { subscriber, consumer, lines } = await boot();
    const started = subscriber.start();
    consumer.emit('ready');
    await started;

    consumer.neverCloses = true;
    await subscriber.stop();

    expect(lines.find((line) => line.level === 'warn')?.message).toContain(
      'did not drain within 50 ms',
    );
  });
});
