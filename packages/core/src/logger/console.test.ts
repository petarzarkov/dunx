import { afterEach, describe, expect, it } from 'bun:test';
import { ConsoleLogger } from './console.js';
import { AsyncRequestContext } from './context.js';
import { LogLevel } from './types.js';

/**
 * The default binding for `Logger`, so this is what an app that imported no logging
 * module actually gets - including `@dunx/http`'s request logging, which is on by
 * default. It writes one JSON line per entry and nothing more; `@dunx/infra/logger`
 * replaces it with `@arkv/logger` for sanitizing, masking and rotation.
 */
interface Captured {
  readonly out: Record<string, unknown>[];
  readonly err: Record<string, unknown>[];
}

const original = { log: console.log, error: console.error };

/**
 * Entries at `info` and below are batched into one write per event-loop turn, so
 * a captured call may carry several lines and the buffer has to be flushed before
 * the real `console` comes back - otherwise the tail of a test lands on the
 * terminal instead of in `out`.
 */
const capture = (run: () => void): Captured => {
  const out: Record<string, unknown>[] = [];
  const err: Record<string, unknown>[] = [];
  const into =
    (target: Record<string, unknown>[]) =>
    (line: unknown): void => {
      for (const one of String(line).split('\n')) target.push(JSON.parse(one));
    };
  console.log = into(out);
  console.error = into(err);
  try {
    run();
    new ConsoleLogger().flush();
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
  return { out, err };
};

afterEach(() => {
  console.log = original.log;
  console.error = original.error;
});

describe('ConsoleLogger', () => {
  it('defaults to info, dropping anything below it', () => {
    const logger = new ConsoleLogger();
    expect(logger.logLevel).toBe(LogLevel.INFO);

    const { out } = capture(() => {
      logger.verbose('dropped');
      logger.debug('dropped');
      logger.info('kept');
    });

    expect(out.map((entry) => entry['message'])).toEqual(['kept']);
  });

  it('honours a configured level', () => {
    const logger = new ConsoleLogger(undefined, LogLevel.VERBOSE);

    const { out } = capture(() => {
      logger.verbose('now kept');
      logger.debug('also kept');
    });

    expect(out).toHaveLength(2);
  });

  it('writes warn and above to stderr, so a shipper can split them', () => {
    const logger = new ConsoleLogger(undefined, LogLevel.VERBOSE);

    const { out, err } = capture(() => {
      logger.verbose('a');
      logger.debug('b');
      logger.info('c');
      logger.warn('d');
      logger.error('e');
      logger.fatal('f');
    });

    expect(out.map((entry) => entry['level'])).toEqual([
      'verbose',
      'debug',
      'info',
    ]);
    expect(err.map((entry) => entry['level'])).toEqual([
      'warn',
      'error',
      'fatal',
    ]);
  });

  it('stamps every entry with level, timestamp, pid and message', () => {
    const { out } = capture(() => new ConsoleLogger().info('hello'));

    const entry = out[0];
    expect(entry?.['level']).toBe('info');
    expect(entry?.['message']).toBe('hello');
    expect(entry?.['pid']).toBe(process.pid);
    expect(typeof entry?.['timestamp']).toBe('string');
    expect(new Date(String(entry?.['timestamp'])).getTime()).toBeGreaterThan(0);
  });

  it('emits `info` from the deprecated `log` alias', () => {
    const { out } = capture(() => new ConsoleLogger().log('via alias'));
    expect(out[0]?.['level']).toBe('info');
  });

  it('merges a trailing object into the entry', () => {
    const { out } = capture(() =>
      new ConsoleLogger().info('created', { userId: 7, plan: 'pro' }),
    );

    expect(out[0]).toMatchObject({
      message: 'created',
      userId: 7,
      plan: 'pro',
    });
  });

  it('serialises an Error rather than dropping it to {}', () => {
    const { err } = capture(() =>
      new ConsoleLogger().error('failed', new Error('the cause')),
    );

    // JSON.stringify(new Error()) is "{}", which is the trap this avoids.
    expect(err[0]?.['error']).toMatchObject({
      name: 'Error',
      message: 'the cause',
    });
    const serialised = err[0]?.['error'] as { stack?: string } | undefined;
    expect(serialised?.stack).toContain('Error: the cause');
  });

  it('takes an Error as the whole message', () => {
    const { err } = capture(() =>
      new ConsoleLogger().error(new Error('bare error')),
    );

    expect(err[0]?.['message']).toBe('bare error');
    expect(err[0]?.['error']).toMatchObject({ message: 'bare error' });
  });

  it('names an object-only call rather than pretending it had a message', () => {
    const { out } = capture(() => new ConsoleLogger().info({ orderId: 9 }));

    expect(out[0]?.['message']).toBe('Object logged');
    expect(out[0]?.['orderId']).toBe(9);
  });

  it('merges the request context, which is how traceId reaches an entry', () => {
    const context = new AsyncRequestContext();
    const logger = new ConsoleLogger(context);

    const { out } = capture(() => {
      context.runWithContext({ traceId: 'r1', flow: 'http' }, () => {
        logger.info('inside');
      });
      logger.info('outside');
    });

    expect(out[0]).toMatchObject({
      message: 'inside',
      traceId: 'r1',
      flow: 'http',
    });
    expect(out[1]?.['traceId']).toBeUndefined();
  });

  it('lets a per-call field win over the context', () => {
    const context = new AsyncRequestContext();
    const logger = new ConsoleLogger(context);

    const { out } = capture(() => {
      context.runWithContext({ userId: 'from-context' }, () => {
        logger.info('explicit wins', { userId: 'from-call' });
      });
    });

    expect(out[0]?.['userId']).toBe('from-call');
  });

  it('works with no context at all', () => {
    const { out } = capture(() => new ConsoleLogger().info('no context'));
    expect(out[0]?.['message']).toBe('no context');
  });
});

/**
 * One `console.log` per request measured at 1.84 µs on `bun run logging` - the
 * single largest component of request logging. Batching is what removes it, and
 * the durability the batch gives up is bounded by the two rules asserted here.
 */
describe('ConsoleLogger buffering', () => {
  it('holds an info entry until the buffer is flushed', () => {
    const seen: string[] = [];
    console.log = (line: unknown) => seen.push(String(line));
    const logger = new ConsoleLogger();
    try {
      logger.info('held');
      expect(seen).toHaveLength(0);
      logger.flush();
      expect(seen).toHaveLength(1);
    } finally {
      console.log = original.log;
    }
    expect(JSON.parse(String(seen[0]))['message']).toBe('held');
  });

  it('batches a turn of entries into one write', () => {
    const seen: string[] = [];
    console.log = (line: unknown) => seen.push(String(line));
    const logger = new ConsoleLogger();
    try {
      logger.info('one');
      logger.info('two');
      logger.info('three');
      logger.flush();
    } finally {
      console.log = original.log;
    }

    expect(seen).toHaveLength(1);
    expect(String(seen[0]).split('\n')).toHaveLength(3);
  });

  it('never buffers warn and above, and flushes what is queued behind them', () => {
    const order: string[] = [];
    console.log = (line: unknown) => order.push(`out:${String(line)}`);
    console.error = (line: unknown) => order.push(`err:${String(line)}`);
    const logger = new ConsoleLogger();
    try {
      logger.info('before');
      logger.error('the failure');
    } finally {
      console.log = original.log;
      console.error = original.error;
    }

    // The info went out with the error and not after it: an entry you would go
    // looking for after a crash is never held, and neither is anything ahead of it.
    expect(order).toHaveLength(2);
    expect(order[0]?.startsWith('out:')).toBe(true);
    expect(order[1]?.startsWith('err:')).toBe(true);
  });

  it('flushes on shutdown, which is the hook the container calls', () => {
    const seen: string[] = [];
    console.log = (line: unknown) => seen.push(String(line));
    const logger = new ConsoleLogger();
    try {
      logger.info('pending at shutdown');
      logger.onShutdown();
    } finally {
      console.log = original.log;
    }
    expect(seen).toHaveLength(1);
  });

  it('writes every entry as it happens when buffering is off', () => {
    const seen: string[] = [];
    console.log = (line: unknown) => seen.push(String(line));
    const logger = new ConsoleLogger(undefined, 'info', false);
    try {
      logger.info('one');
      logger.info('two');
    } finally {
      console.log = original.log;
    }
    expect(seen).toHaveLength(2);
  });
});
