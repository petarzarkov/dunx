import { AsyncRequestContext, ConsoleLogger, type Logger } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { ConsumerStatus, type AsyncMessage } from 'rabbitmq-client';
import { AmqpDispatcher, type DispatchSettings } from './dispatcher.js';
import type { DiscoveredSubscription } from './discover.js';
import { AmqpErrorCode } from './errors.js';

interface Line {
  readonly level: 'debug' | 'warn' | 'error';
  readonly message: unknown;
  readonly params: readonly unknown[];
}

/**
 * A real `ConsoleLogger` at `fatal` with the three levels this writes shadowed, so
 * the suite asserts on the level policy and stays quiet. Spreading one would copy
 * `logLevel` and nothing else: its methods are on the prototype.
 */
/** The first entry at `level`, which every assertion below reads. */
const at = (lines: readonly Line[], level: Line['level']): Line => {
  const found = lines.find((line) => line.level === level);
  if (found === undefined) throw new Error(`nothing was logged at ${level}`);
  return found;
};

const recorder = (): { logger: Logger; lines: Line[] } => {
  const lines: Line[] = [];
  const logger = new ConsoleLogger(undefined, 'fatal');
  for (const level of ['debug', 'warn', 'error'] as const) {
    logger[level] = (message: unknown, ...params: unknown[]): void => {
      lines.push({ level, message, params });
    };
  }
  return { logger, lines };
};

const message = (over: Partial<AsyncMessage> = {}): AsyncMessage =>
  ({
    body: { id: 1 },
    consumerTag: 'ct',
    deliveryTag: 1,
    exchange: '',
    redelivered: false,
    routingKey: 'orders',
    ...over,
  }) as AsyncMessage;

const subscription = (
  handler: DiscoveredSubscription['handler'],
): DiscoveredSubscription => ({
  queue: 'orders',
  provider: 'Orders',
  method: 'onOrder',
  handler,
});

const settings = (over: Partial<DispatchSettings> = {}): DispatchSettings => ({
  requeue: true,
  timeoutMs: undefined,
  ...over,
});

describe('dispatching one delivery', () => {
  it('acks a handler that returns', async () => {
    const dispatcher = new AmqpDispatcher(recorder().logger);
    const status = await dispatcher.dispatch(
      subscription(() => 'done'),
      settings(),
      message(),
    );
    expect(status).toBe(ConsumerStatus.ACK);
  });

  it('passes a status the handler returned straight through', async () => {
    const dispatcher = new AmqpDispatcher(recorder().logger);
    expect(
      await dispatcher.dispatch(
        subscription(() => ConsumerStatus.DROP),
        settings(),
        message(),
      ),
    ).toBe(ConsumerStatus.DROP);
  });

  /**
   * A throw never leaves the dispatcher. `rabbitmq-client` would nack it and emit
   * `error` on the consumer, which carries no message identity, so the failure
   * would be logged without saying which delivery failed.
   */
  it('requeues a throw and logs it once, naming the message and the handler', async () => {
    const { logger, lines } = recorder();
    const dispatcher = new AmqpDispatcher(logger);

    const status = await dispatcher.dispatch(
      subscription(() => {
        throw new Error('boom');
      }),
      settings(),
      message({ messageId: 'm-1' }),
    );

    expect(status).toBe(ConsumerStatus.REQUEUE);
    const failure = at(lines, 'error');
    expect(failure.message).toContain('Orders.onOrder()');
    expect(failure.message).toContain('m-1 orders[orders]');
    expect(failure.message).toContain('requeueing');
    // Positionally, not as `{ error }`: an Error's own properties are
    // non-enumerable, so wrapping it logs a line saying something failed
    // without saying what.
    expect((failure.params[0] as Error).message).toBe('boom');
  });

  it('drops a throw when requeue is off', async () => {
    const { logger, lines } = recorder();
    const status = await new AmqpDispatcher(logger).dispatch(
      subscription(() => Promise.reject(new Error('boom'))),
      settings({ requeue: false }),
      message(),
    );
    expect(status).toBe(ConsumerStatus.DROP);
    expect(at(lines, 'error').message).toContain('dropping');
  });

  /** A redelivery means an earlier attempt failed or a consumer died holding it. */
  it('warns on a redelivery, which the handler line cannot say', async () => {
    const { logger, lines } = recorder();
    await new AmqpDispatcher(logger).dispatch(
      subscription(() => undefined),
      settings(),
      message({ redelivered: true }),
    );
    expect(lines.some((line) => line.level === 'warn')).toBe(true);
  });
});

describe('handlerTimeoutMs', () => {
  it('rejects a handler that outruns it, and nacks rather than hanging', async () => {
    const { logger, lines } = recorder();
    const status = await new AmqpDispatcher(logger).dispatch(
      subscription(() => Bun.sleep(1_000)),
      settings({ timeoutMs: 10 }),
      message(),
    );

    expect(status).toBe(ConsumerStatus.REQUEUE);
    expect((at(lines, 'error').params[0] as Error).message).toContain(
      'exceeded handlerTimeoutMs (10ms)',
    );
  });

  it('carries the error code, so a caller can tell a timeout from a throw', async () => {
    const { logger, lines } = recorder();
    await new AmqpDispatcher(logger).dispatch(
      subscription(() => Bun.sleep(1_000)),
      settings({ timeoutMs: 5 }),
      message(),
    );
    expect((at(lines, 'error').params[0] as { code?: string }).code).toBe(
      AmqpErrorCode.TIMED_OUT,
    );
  });

  it('clears the timer for a handler that finished in time', async () => {
    // Otherwise the process cannot exit until the longest pending timer fires.
    const started = Bun.nanoseconds();
    await new AmqpDispatcher(recorder().logger).dispatch(
      subscription(() => undefined),
      settings({ timeoutMs: 10_000 }),
      message(),
    );
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(500);
  });
});

describe('the trace a delivery runs in', () => {
  const traceOf = async (over: Partial<AsyncMessage>) => {
    const context = new AsyncRequestContext();
    let seen: ReturnType<AsyncRequestContext['getContext']> | undefined;
    await new AmqpDispatcher(recorder().logger, context).dispatch(
      subscription(() => {
        seen = context.getContext();
      }),
      settings(),
      message(over),
    );
    return seen;
  };

  it('continues the publisher trace with a span of its own', async () => {
    const traceId = 'a'.repeat(32);
    const spanId = 'b'.repeat(16);
    const seen = await traceOf({
      headers: {
        traceparent: `00-${traceId}-${spanId}-01`,
        tracestate: 'vendor=1',
      },
    });

    expect(seen?.traceId).toBe(traceId);
    expect(seen?.parentSpanId).toBe(spanId);
    expect(seen?.spanId).not.toBe(spanId);
    expect(seen?.traceFlags).toBe('01');
    expect(seen?.traceState).toBe('vendor=1');
  });

  it('starts a trace when none arrived, so the handler lines still correlate', async () => {
    const seen = await traceOf({});
    expect(seen?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(seen?.parentSpanId).toBeUndefined();
  });

  it('discards a malformed traceparent rather than repairing it', async () => {
    const seen = await traceOf({ headers: { traceparent: 'nonsense' } });
    expect(seen?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(seen?.parentSpanId).toBeUndefined();
  });

  /** `tracestate` belongs to the `traceparent` it arrived with: keeping it would
   * attach one trace's vendor state to another's ids. */
  it('drops tracestate with the traceparent it arrived with', async () => {
    const seen = await traceOf({
      headers: { traceparent: 'nonsense', tracestate: 'vendor=1' },
    });
    expect(seen?.traceState).toBeUndefined();
  });

  it('names the queue and the handler, which is what a log pipeline groups on', async () => {
    const seen = await traceOf({});
    expect(seen?.flow).toBe('amqp');
    expect(seen?.event).toBe('orders');
    expect(seen?.context).toBe('Orders.onOrder');
  });
});
