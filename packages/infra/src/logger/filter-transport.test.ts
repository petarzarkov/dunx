import { describe, expect, it } from 'bun:test';
import { type LogFilter, LogLevel } from '@dunx/core';
import {
  ConsoleTransport,
  jsonFormat,
  Logger as ArkvLogger,
  type LoggerConfig,
  type LogFormatter,
  prettyFormat,
  type Transport,
} from '@arkv/logger';
import { MemoryTransport } from '@arkv/logger/testing';
import { FilteringTransport, filteredTransports } from './filter-transport.js';

const mask: LogFilter = (entry) => ({ ...entry, password: '[MASKED]' });
const dropProbes: LogFilter = (entry) =>
  String(entry['event']).startsWith('/health') ? undefined : entry;

/** A `write` for a fake sink: several cases only care about its other members. */
const ignore: Transport['write'] = () => undefined;

describe('FilteringTransport', () => {
  it('hands the sink what the filter returned', () => {
    const inner = new MemoryTransport();
    const wrapped = new FilteringTransport(inner, [mask]);

    wrapped.write({ message: 'sign-in', password: 'hunter2' }, LogLevel.INFO);

    expect(inner.entries).toEqual([
      { message: 'sign-in', password: '[MASKED]' },
    ]);
  });

  it('writes nothing when a filter drops the entry', () => {
    const inner = new MemoryTransport();
    const wrapped = new FilteringTransport(inner, [dropProbes]);

    wrapped.write({ message: 'probe', event: '/health/live' }, LogLevel.INFO);

    expect(inner.entries).toEqual([]);
  });

  it('hands the filter the level', () => {
    const seen: LogLevel[] = [];
    const watch: LogFilter = (entry, level) => {
      seen.push(level);
      return entry;
    };

    new FilteringTransport(new MemoryTransport(), [watch]).write(
      { message: 'x' },
      LogLevel.ERROR,
    );

    expect(seen).toEqual([LogLevel.ERROR]);
  });

  it('re-exposes a per-sink level, so its threshold survives the wrapper', () => {
    const limited = new MemoryTransport({ level: LogLevel.WARN });

    expect(new FilteringTransport(limited, [mask]).level).toBe(LogLevel.WARN);
    expect(new FilteringTransport(new MemoryTransport(), [mask]).level).toBe(
      undefined,
    );
  });

  it('forwards flush and close to a sink that implements them', () => {
    let flushed = 0;
    let closed = 0;
    const inner: Transport = {
      write: ignore,
      flush: () => {
        flushed += 1;
      },
      close: () => {
        closed += 1;
      },
    };
    const wrapped = new FilteringTransport(inner, [mask]);

    wrapped.flush();
    wrapped.close();

    expect([flushed, closed]).toEqual([1, 1]);
  });

  it('resolves without a sink that has neither, rather than throwing', () => {
    const bare: Transport = { write: ignore };
    const wrapped = new FilteringTransport(bare, [mask]);

    expect(() => {
      wrapped.flush();
      wrapped.close();
    }).not.toThrow();
  });

  /**
   * The logger prefers the awaited pair when a transport has one, so declaring
   * them unconditionally would take a synchronously buffered sink down a path
   * that never calls its `flush`.
   */
  it('falls back to the synchronous flush for a sink with no awaited one', async () => {
    let flushed = 0;
    const inner: Transport = {
      write: ignore,
      flush: () => {
        flushed += 1;
      },
    };

    await new FilteringTransport(inner, [mask]).flushAsync();

    expect(flushed).toBe(1);
  });

  it('prefers the sink own awaited flush when it has one', async () => {
    let awaited = 0;
    let sync = 0;
    const inner: Transport = {
      write: ignore,
      flush: () => {
        sync += 1;
      },
      flushAsync: async () => {
        awaited += 1;
      },
    };

    await new FilteringTransport(inner, [mask]).flushAsync();

    expect([awaited, sync]).toEqual([1, 0]);
  });

  it('reports the sink stats, and none when it has none', () => {
    const stats = { name: 'Inner', dropped: 2, queued: 0, errors: 0 };
    const inner: Transport = { write: ignore, stats: () => stats };

    expect(new FilteringTransport(inner, [mask]).stats?.()).toEqual(stats);
    expect(
      new FilteringTransport(new MemoryTransport(), [mask]).stats,
    ).toBeUndefined();
  });

  /**
   * Deliberately not caught here. arkv's transport machinery is what contains a
   * throwing sink, reports it once and moves on, and swallowing the throw in the
   * wrapper would take that report away. The outcome is the same as
   * `ConsoleLogger`'s - entry dropped, caller not failed - reached from the other
   * side.
   */
  it('lets a filter throw reach the logger rather than swallowing it', () => {
    const boom: LogFilter = () => {
      throw new Error('filter boom');
    };
    const inner = new MemoryTransport();
    const wrapped = new FilteringTransport(inner, [boom]);

    expect(() => wrapped.write({ message: 'x' }, LogLevel.INFO)).toThrow(
      'filter boom',
    );
    expect(inner.entries).toEqual([]);
  });
});

/** What one config renders, with `console.log` captured for the duration. */
const renderedBy = async (config: LoggerConfig): Promise<string> => {
  const logger = new ArkvLogger(config);
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    logger.info('GET /notes 200', { statusCode: 200 });
  } finally {
    console.log = original;
  }
  // Generated per entry, so two loggers never agree on it. Replaced here the way
  // every other arkv output comparison replaces it: the position is the part
  // under test, not the value.
  return lines.join('\n').replace(/"timestamp":"[^"]*"/g, '"timestamp":"T"');
};

/**
 * `filteredTransports` rebuilds upstream's default console transport, because
 * arkv constructs its own privately and there would otherwise be nothing to wrap.
 * That copy is the one thing here that can drift silently, so it is asserted
 * against upstream's own default rather than trusted.
 *
 * **Only with colours on.** Without them `jsonFormat` and `prettyFormat` render
 * identical bytes for every entry shape tried, so a comparison here cannot see a
 * wrong `format` at all: it would pass whether the copy is right or wrong, which
 * is worse than not having it. Measured before this was written - flat, nested,
 * error and long entries all rendered identically. `FORCE_COLOR=1` (or a TTY)
 * makes the two differ, and the guard is skipped rather than green when it cannot
 * bite. Recorded in internal/notes/roadmap/arkv-integrations.md.
 */
const formattersAreDistinguishable = await (async (): Promise<boolean> => {
  const base: LoggerConfig = { level: LogLevel.INFO, isDevelopment: true };
  const rendered = (format: LogFormatter): Promise<string> =>
    renderedBy({ ...base, transports: [new ConsoleTransport({ format })] });
  return (await rendered(jsonFormat)) !== (await rendered(prettyFormat));
})();

describe('the rebuilt default transport', () => {
  for (const isDevelopment of [false, true]) {
    it.skipIf(!formattersAreDistinguishable)(
      `renders exactly what upstream renders, isDevelopment: ${isDevelopment}`,
      async () => {
        const base: LoggerConfig = { level: LogLevel.INFO, isDevelopment };

        const upstream = await renderedBy(base);
        const rebuilt = await renderedBy({
          ...base,
          transports: filteredTransports(base, [], isDevelopment),
        });

        // The control. If the wrong format also matched, the assertion below would
        // prove nothing, so this fails first and says so.
        expect(
          await renderedBy({
            ...base,
            transports: [new ConsoleTransport({ format: jsonFormat })],
          }),
        ).not.toBe(
          await renderedBy({
            ...base,
            transports: [new ConsoleTransport({ format: prettyFormat })],
          }),
        );

        expect(upstream).not.toBe('');
        expect(rebuilt).toBe(upstream);
      },
    );
  }
});
