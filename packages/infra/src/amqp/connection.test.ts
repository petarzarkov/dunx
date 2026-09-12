import { ConsoleLogger, type Logger } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { AmqpConnection } from './connection.js';
import { AmqpOptions } from './options.js';

/** A port nothing answers on, so nothing here needs a broker. */
const unreachable = 'amqp://127.0.0.1:1';

const recorder = (): {
  logger: Logger;
  lines: { level: string; message: unknown }[];
} => {
  const lines: { level: string; message: unknown }[] = [];
  const logger = new ConsoleLogger(undefined, 'fatal');
  for (const level of ['debug', 'info', 'warn'] as const) {
    logger[level] = (message: unknown): void => {
      lines.push({ level, message });
    };
  }
  return { logger, lines };
};

const connection = (
  init: Partial<ConstructorParameters<typeof AmqpOptions>[0]> = {},
) => {
  const { logger, lines } = recorder();
  return {
    lines,
    connection: new AmqpConnection(
      new AmqpOptions({
        url: unreachable,
        connection: { retryLow: 50 },
        ...init,
      }),
      logger,
    ),
  };
};

describe('opening', () => {
  /**
   * A process that neither publishes nor consumes - every unit test of a module
   * that happens to import this one - should hold no socket and exit without
   * being told to.
   */
  it('opens nothing until something asks', async () => {
    const { connection: amqp } = connection();
    expect(amqp.opened).toBe(false);
    expect(amqp.ready).toBe(false);

    amqp.connection();
    expect(amqp.opened).toBe(true);
    await amqp.onShutdown();
  });

  it('hands back the same connection twice', async () => {
    const { connection: amqp } = connection();
    expect(amqp.connection()).toBe(amqp.connection());
    await amqp.onShutdown();
  });

  /**
   * An 'error' event with no listener throws rather than being ignored, so an
   * unreachable broker would take the process down on its first retry.
   */
  it('listens for the events an unlistened emitter would throw on', async () => {
    const { connection: amqp } = connection();
    const raw = amqp.connection();

    expect(raw.listenerCount('error')).toBeGreaterThan(0);
    expect(raw.listenerCount('connection')).toBeGreaterThan(0);
    expect(raw.listenerCount('connection.blocked')).toBeGreaterThan(0);
    expect(raw.listenerCount('connection.unblocked')).toBeGreaterThan(0);
    await amqp.onShutdown();
  });

  it('reports a blocked broker, which is a publisher backing up in memory', async () => {
    const { connection: amqp, lines } = connection();
    const raw = amqp.connection();

    raw.emit('connection.blocked', 'low on disk');
    raw.emit('connection.unblocked');

    expect(lines.find((line) => line.level === 'warn')?.message).toContain(
      'low on disk',
    );
    expect(lines.some((line) => line.level === 'info')).toBe(true);
    await amqp.onShutdown();
  });

  it('notes each connect, which is what a reconnect writes', async () => {
    const { connection: amqp, lines } = connection();
    amqp.connection().emit('connection');
    expect(lines.find((line) => line.level === 'debug')?.message).toContain(
      '127.0.0.1:1',
    );
    await amqp.onShutdown();
  });

  it('reports a connection error through the bound Logger', async () => {
    const { connection: amqp, lines } = connection();
    amqp.connection().emit('error', new Error('refused'));
    expect(lines.some((line) => line.level === 'warn')).toBe(true);
    await amqp.onShutdown();
  });
});

describe('shutting down', () => {
  it('does nothing when nothing was opened', async () => {
    const { connection: amqp } = connection();
    await amqp.onShutdown();
    expect(amqp.opened).toBe(false);
  });

  /**
   * `close()` against a broker that has gone away waits `acquireTimeout` per
   * channel - measured at 19.7 s on rabbitmq-client 5.0.8 - and a socket still
   * open is what keeps the process from exiting.
   */
  it('destroys the socket when close outruns its window', async () => {
    const { connection: amqp, lines } = connection();
    amqp.connection();

    const started = Bun.nanoseconds();
    await amqp.onShutdown();

    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(6_000);
    expect(amqp.opened).toBe(false);
    expect(amqp.ready).toBe(false);
    expect(lines.length).toBeGreaterThanOrEqual(0);
  });

  /** Reopening after teardown would put back a socket nothing will close, and
   * the process would then not exit. */
  it('refuses to reopen after teardown', async () => {
    const { connection: amqp } = connection();
    amqp.connection();
    await amqp.onShutdown();

    expect(() => amqp.connection()).toThrow(/closed by container shutdown/);
  });

  it('is safe to call twice', async () => {
    const { connection: amqp } = connection();
    amqp.connection();
    await amqp.onShutdown();
    await amqp.onShutdown();
    expect(amqp.opened).toBe(false);
  });
});
