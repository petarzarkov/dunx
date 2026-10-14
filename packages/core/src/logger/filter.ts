import type { LogEntry, LogLevel } from './types.js';

/**
 * One stage between a built entry and wherever that entry is written.
 *
 * Return the entry to pass on, either the one it was handed or a replacement, or
 * `undefined` to drop it. Those two answers cover the three shapes a caller
 * writes: a rewrite (`{ ...entry, password: '[MASKED]' }`), a removal (`const
 * { token, ...rest } = entry; return rest`) and a drop (`return undefined`).
 *
 * Pure. A filter must not mutate what it is handed, because a logger with several
 * destinations may hand the same object to each of them, and a `delete` here
 * would be visible to the next one.
 */
export type LogFilter = (
  entry: LogEntry,
  level: LogLevel,
) => LogEntry | undefined;

/**
 * The filters in order, stopping at the first that drops the entry.
 *
 * An empty list returns the entry itself rather than a copy, so a logger with no
 * filters allocates nothing on the way to its sink.
 */
export const runFilters = (
  entry: LogEntry,
  level: LogLevel,
  filters: readonly LogFilter[],
): LogEntry | undefined => {
  let current = entry;
  for (const filter of filters) {
    const next = filter(current, level);
    if (next === undefined) return undefined;
    current = next;
  }
  return current;
};
