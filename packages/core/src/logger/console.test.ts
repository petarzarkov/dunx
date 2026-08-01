import { afterEach, describe, expect, it } from 'bun:test';
import { ConsoleLogger } from './console.js';
import { AsyncRequestContext } from './context.js';
import { LogLevel } from './types.js';

/**
 * The default binding for `Logger`, so this is what an app that imported no logging
 * module actually gets — including `@dunx/http`'s request logging, which is on by
 * default. It writes one JSON line per entry and nothing more; `@dunx/infra/logger`
 * replaces it with `@arkv/logger` for sanitizing, masking and rotation.
 */
interface Captured {
  readonly out: Record<string, unknown>[];
  readonly err: Record<string, unknown>[];
}

const original = { log: console.log, error: console.error };

const capture = (run: () => void): Captured => {
  const out: Record<string, unknown>[] = [];
  const err: Record<string, unknown>[] = [];
  console.log = (line: unknown) => out.push(JSON.parse(String(line)));
  console.error = (line: unknown) => err.push(JSON.parse(String(line)));
  try {
    run();
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

  it('merges the request context, which is how requestId reaches an entry', () => {
    const context = new AsyncRequestContext();
    const logger = new ConsoleLogger(context);

    const { out } = capture(() => {
      context.runWithContext({ requestId: 'r1', flow: 'http' }, () => {
        logger.info('inside');
      });
      logger.info('outside');
    });

    expect(out[0]).toMatchObject({
      message: 'inside',
      requestId: 'r1',
      flow: 'http',
    });
    expect(out[1]?.['requestId']).toBeUndefined();
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
