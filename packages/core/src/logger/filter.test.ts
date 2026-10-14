import { describe, expect, it } from 'bun:test';
import { runFilters, type LogFilter } from './filter.js';
import type { LogEntry, LogLevel } from './types.js';

const entry = (fields: Record<string, unknown> = {}): LogEntry => ({
  level: 'info',
  timestamp: '2026-01-01T00:00:00.000Z',
  message: 'hello',
  ...fields,
});

describe('runFilters', () => {
  it('returns the entry it was handed when there is nothing to run', () => {
    const original = entry();
    // By reference, not by value: a logger with no filters must allocate nothing.
    expect(runFilters(original, 'info', [])).toBe(original);
  });

  it('hands each filter the previous one result, in order', () => {
    const seen: string[] = [];
    const first: LogFilter = (current) => {
      seen.push(`first:${String(current['message'])}`);
      return { ...current, message: 'one' };
    };
    const second: LogFilter = (current) => {
      seen.push(`second:${String(current['message'])}`);
      return { ...current, message: 'two' };
    };

    const result = runFilters(entry(), 'info', [first, second]);

    expect(result?.['message']).toBe('two');
    expect(seen).toEqual(['first:hello', 'second:one']);
  });

  it('stops at the first filter that drops the entry', () => {
    let reached = 0;
    const drop: LogFilter = () => undefined;
    const after: LogFilter = (current) => {
      reached += 1;
      return current;
    };

    expect(runFilters(entry(), 'info', [drop, after])).toBeUndefined();
    expect(reached).toBe(0);
  });

  it('hands every filter the level', () => {
    const levels: LogLevel[] = [];
    const watch: LogFilter = (current, level) => {
      levels.push(level);
      return current;
    };

    runFilters(entry(), 'warn', [watch, watch]);

    expect(levels).toEqual(['warn', 'warn']);
  });

  it('leaves the entry it was handed alone when a filter copies', () => {
    const original = entry({ token: 'secret', keep: 1 });
    const scrub: LogFilter = (current) => {
      const next = { ...current };
      delete next['token'];
      return next;
    };

    const result = runFilters(original, 'info', [scrub]);

    expect(result).toEqual({
      level: 'info',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: 'hello',
      keep: 1,
    });
    expect(original['token']).toBe('secret');
  });
});
