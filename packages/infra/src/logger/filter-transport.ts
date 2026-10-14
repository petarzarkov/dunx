import {
  ConsoleTransport,
  type LogEntry as ArkvEntry,
  jsonFormat,
  type LoggerConfig,
  prettyFormat,
  type Transport,
  type TransportStats,
} from '@arkv/logger';
import { type LogFilter, type LogLevel, runFilters } from '@dunx/core';

/**
 * Runs the filters on the way in, so the sink behind it only ever sees the result.
 *
 * A wrapper rather than a change to `Logger`, because `@arkv/logger` owns the
 * entry-building step and dunx cannot reach between it and the transports any other
 * way. The filter therefore sees the entry **after** upstream's sanitizing: a
 * rewrite here is what a key-name `maskFields` could not express, not a
 * replacement for it.
 *
 * Optional members are forwarded **only when the wrapped transport has them**,
 * except the awaited pair, which falls back to the synchronous one. The logger
 * prefers `flushAsync`/`closeAsync` when it sees them, so a wrapper that always
 * declared them would take a buffer whose only drain is synchronous down a path
 * that never calls it.
 */
export class FilteringTransport implements Transport {
  readonly #inner: Transport;
  readonly #filters: readonly LogFilter[];

  /** Present only when the wrapped transport has one. */
  declare level?: LogLevel;
  /**
   * Present only when the wrapped transport has one. `stats` cannot answer
   * "nothing": a wrapper reporting zero dropped would hide the real count.
   */
  declare stats?: () => TransportStats;

  constructor(inner: Transport, filters: readonly LogFilter[]) {
    this.#inner = inner;
    this.#filters = filters;
    if (inner.level !== undefined) this.level = inner.level;
    if (inner.stats !== undefined) this.stats = inner.stats.bind(inner);
  }

  write(entry: ArkvEntry, level: LogLevel): void {
    const filtered = runFilters(entry, level, this.#filters);
    if (filtered === undefined) return;
    // The one cast in this file, and it is upstream's declaration catching up
    // rather than a conversion: arkv types `LogEntry.error` as `Error`, but a sink
    // is handed the *sanitized* entry, where that field is already the serialized
    // form dunx declares. Same object either way. Recorded in
    // internal/notes/roadmap/arkv-integrations.md.
    this.#inner.write(filtered as ArkvEntry, level);
  }

  flush(): void {
    this.#inner.flush?.();
  }

  close(): void {
    this.#inner.close?.();
  }

  async flushAsync(): Promise<void> {
    if (this.#inner.flushAsync !== undefined) await this.#inner.flushAsync();
    else this.#inner.flush?.();
  }

  async closeAsync(): Promise<void> {
    if (this.#inner.closeAsync !== undefined) await this.#inner.closeAsync();
    else this.#inner.close?.();
  }
}

/**
 * Every sink the config names, each behind the filters.
 *
 * The default console transport is rebuilt here when the config names none,
 * because arkv builds its own privately and there would otherwise be nothing to
 * wrap - `forRoot({ filters })` with no `transports` is the common case, and a
 * filter that silently did nothing there would be worse than no filter support.
 * That copy has to track upstream's `batch` and `isDevelopment` choices; it is
 * the one place this wiring can drift, and it belongs upstream.
 */
export const filteredTransports = (
  config: LoggerConfig,
  filters: readonly LogFilter[],
  isDevelopment: boolean,
): Transport[] =>
  (
    config.transports ?? [
      new ConsoleTransport({
        batch: config.batchConsole ?? false,
        format: isDevelopment ? prettyFormat : jsonFormat,
      }),
    ]
  ).map((transport) => new FilteringTransport(transport, filters));
