import {
  AsyncRequestContext,
  ConsoleLogger,
  type Logger,
  type OnShutdown,
} from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import type { Envelope, MessageBody, Publisher } from 'rabbitmq-client';
import { AmqpConnection } from './connection.js';
import { AmqpOptions } from './options.js';
import { AmqpPublisher } from './publisher.js';

interface Sent {
  readonly envelope: Envelope;
  readonly body: MessageBody;
}

/** A `Publisher` with the three members this class touches, so the trace stamping
 * is assertable without a broker. */
class FakePublisher {
  readonly sent: Sent[] = [];
  readonly listeners = new Map<string, (value: never) => void>();
  closed = 0;
  failClose = false;

  send(envelope: Envelope, body: MessageBody): Promise<void> {
    this.sent.push({ envelope, body });
    return Promise.resolve();
  }

  on(name: string, callback: (value: never) => void): this {
    this.listeners.set(name, callback);
    return this;
  }

  close(): Promise<void> {
    this.closed++;
    return this.failClose
      ? Promise.reject(new Error('channel gone'))
      : Promise.resolve();
  }
}

const recorder = (): {
  logger: Logger;
  lines: { level: string; message: unknown }[];
} => {
  const lines: { level: string; message: unknown }[] = [];
  const logger = new ConsoleLogger(undefined, 'fatal');
  for (const level of ['debug', 'warn'] as const) {
    logger[level] = (message: unknown): void => {
      lines.push({ level, message });
    };
  }
  return { logger, lines };
};

const build = (init: { context?: AsyncRequestContext } = {}) => {
  const fake = new FakePublisher();
  const { logger, lines } = recorder();
  const connection = {
    createPublisher: () => fake as unknown as Publisher,
  } as unknown as AmqpConnection;

  return {
    fake,
    lines,
    publisher: new AmqpPublisher(
      connection,
      new AmqpOptions({ url: 'amqp://127.0.0.1:1' }),
      logger,
      init.context,
    ),
  };
};

describe('opening the channel', () => {
  it('opens nothing until the first publish', async () => {
    const { publisher, fake } = build();
    expect(publisher.opened).toBe(false);

    await publisher.publish('orders', { id: 1 });
    expect(publisher.opened).toBe(true);
    expect(fake.sent).toHaveLength(1);
  });

  it('listens for the events an unlistened emitter would throw on', () => {
    const { publisher, fake } = build();
    publisher.publisher();
    expect([...fake.listeners.keys()].sort()).toEqual([
      'basic.return',
      'retry',
    ]);
  });

  it('reports a retry and an unroutable return through the bound Logger', () => {
    const { publisher, fake, lines } = build();
    publisher.publisher();

    fake.listeners.get('retry')?.(new Error('no route') as never);
    fake.listeners.get('basic.return')?.({
      exchange: 'shop',
      routingKey: 'nobody',
    } as never);

    expect(lines.filter((line) => line.level === 'warn')).toHaveLength(2);
    expect(lines[1]?.message).toContain('shop[nobody]');
  });
});

describe('addressing', () => {
  it('takes a bare queue name as a routing key on the default exchange', async () => {
    const { publisher, fake } = build();
    await publisher.publish('orders', { id: 1 });
    expect(fake.sent[0]?.envelope.routingKey).toBe('orders');
    expect(fake.sent[0]?.envelope.exchange).toBeUndefined();
  });

  it('passes an envelope through whole', async () => {
    const { publisher, fake } = build();
    await publisher.publish(
      { exchange: 'shop', routingKey: 'order.created', messageId: 'm-1' },
      { id: 1 },
    );
    expect(fake.sent[0]?.envelope.exchange).toBe('shop');
    expect(fake.sent[0]?.envelope.messageId).toBe('m-1');
  });
});

describe('the trace it stamps', () => {
  const traceId = 'a'.repeat(32);
  const spanId = 'b'.repeat(16);

  /**
   * The reason to call `publish` rather than `publisher().send()`: without it the
   * consuming service starts a trace of its own and the two halves of one flow
   * never join.
   */
  it('stamps traceparent from the enclosing scope', async () => {
    const context = new AsyncRequestContext();
    const { publisher, fake } = build({ context });

    await context.runWithContext(
      { traceId, spanId, traceFlags: '00', traceState: 'vendor=1' },
      () => publisher.publish('orders', { id: 1 }),
    );

    expect(fake.sent[0]?.envelope.headers?.['traceparent']).toBe(
      `00-${traceId}-${spanId}-00`,
    );
    expect(fake.sent[0]?.envelope.headers?.['tracestate']).toBe('vendor=1');
  });

  it('defaults the flags when the scope carries none', async () => {
    const context = new AsyncRequestContext();
    const { publisher, fake } = build({ context });

    await context.runWithContext({ traceId, spanId }, () =>
      publisher.publish('orders', {}),
    );
    expect(fake.sent[0]?.envelope.headers?.['traceparent']).toEndWith('-01');
  });

  /** A caller forwarding a message it received passes the upstream trace on
   * rather than replacing it with this process's. */
  it('leaves a traceparent the caller set alone', async () => {
    const context = new AsyncRequestContext();
    const { publisher, fake } = build({ context });

    await context.runWithContext({ traceId, spanId }, () =>
      publisher.publish(
        { routingKey: 'orders', headers: { traceparent: 'upstream' } },
        {},
      ),
    );
    expect(fake.sent[0]?.envelope.headers?.['traceparent']).toBe('upstream');
  });

  it('stamps nothing when the scope holds no trace', async () => {
    const context = new AsyncRequestContext();
    const { publisher, fake } = build({ context });
    await publisher.publish('orders', {});
    expect(fake.sent[0]?.envelope.headers).toBeUndefined();
  });

  it('stamps nothing when no RequestContext was bound', async () => {
    const { publisher, fake } = build();
    await publisher.publish('orders', {});
    expect(fake.sent[0]?.envelope.headers).toBeUndefined();
  });
});

describe('shutting down', () => {
  it('closes the channel it opened', async () => {
    const { publisher, fake } = build();
    await publisher.publish('orders', {});
    await (publisher as OnShutdown).onShutdown?.();
    expect(fake.closed).toBe(1);
    expect(publisher.opened).toBe(false);
  });

  it('does nothing when nothing was opened', async () => {
    const { publisher, fake } = build();
    await publisher.onShutdown();
    expect(fake.closed).toBe(0);
  });

  /** A channel that will not close must not stop the rest of teardown, which is
   * what closes the socket under it. */
  it('warns rather than throwing when the close fails', async () => {
    const { publisher, fake, lines } = build();
    await publisher.publish('orders', {});
    fake.failClose = true;

    await publisher.onShutdown();
    expect(lines.some((line) => line.level === 'warn')).toBe(true);
  });
});
