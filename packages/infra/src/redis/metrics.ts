import { Durations, type HistogramSnapshot } from '@dunx/core';

export interface CommandStats {
  /** The verb, uppercased: `GET`, `HSET`, `SUBSCRIBE`. */
  readonly command: string;
  readonly count: number;
  /** Commands whose promise rejected, or which threw synchronously. */
  readonly errors: number;
  /** Nanoseconds. */
  readonly duration: HistogramSnapshot;
}

export interface RedisStatsReport {
  readonly commands: readonly CommandStats[];
  readonly total: number;
  readonly errors: number;
  readonly since: string;
}

interface Series {
  count: number;
  errors: number;
  readonly duration: Durations;
}

const series = (): Series => ({
  count: 0,
  errors: 0,
  duration: new Durations(),
});

/**
 * How long Redis is taking, by command.
 *
 * Recorded at `Redis`'s single command seam, so every method on the connection and
 * every `send()` is timed once, including the ones that reject. The clock covers
 * what this process waited for: serialization, the round trip, and any time the
 * command spent in the offline queue during a reconnect.
 *
 * **The key is the verb and nothing else.** `QueryMetrics` keeps a redacted
 * statement shape for the slowest query; the Redis analogue would be the key, and a
 * key is caller data with no `redact()` that could be written for it.
 *
 * Series are bounded by Redis's own command vocabulary rather than by traffic:
 * `send()` uppercases whatever verb it is given, and a verb derived from data is
 * not a command the server would answer.
 *
 * Bound only when `metrics: true`.
 */
export class RedisMetrics {
  readonly #series = new Map<string, Series>();
  #total = 0;
  #errors = 0;
  #since = new Date();

  observe(command: string, durationNs: number, failed = false): void {
    let stats = this.#series.get(command);
    if (stats === undefined) {
      stats = series();
      this.#series.set(command, stats);
    }
    this.#total += 1;
    stats.count += 1;
    if (failed) {
      this.#errors += 1;
      stats.errors += 1;
    }
    stats.duration.record(durationNs);
  }

  snapshot(): RedisStatsReport {
    const commands: CommandStats[] = [];
    for (const [command, stats] of this.#series) {
      commands.push({
        command,
        count: stats.count,
        errors: stats.errors,
        duration: stats.duration.snapshot(),
      });
    }
    return {
      commands,
      total: this.#total,
      errors: this.#errors,
      since: this.#since.toISOString(),
    };
  }

  reset(): void {
    this.#series.clear();
    this.#total = 0;
    this.#errors = 0;
    this.#since = new Date();
  }
}
