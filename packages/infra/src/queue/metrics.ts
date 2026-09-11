import { Durations, type HistogramSnapshot } from '@dunx/core';
import { CappedSeries } from '../series.js';

export const JobOutcome = Object.freeze({
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMED_OUT: 'timed-out',
} as const);
export type JobOutcome = (typeof JobOutcome)[keyof typeof JobOutcome];

export interface JobStats {
  readonly queue: string;
  readonly name: string;
  readonly published: number;
  /** Enqueues whose `add` rejected. They stay in `published` as well. */
  readonly publishErrors: number;
  /** Nanoseconds, from the `publish()` call to the job id coming back. */
  readonly publishDuration: HistogramSnapshot;
  /** Handlers this container ran. Zero for a queue whose work is forked. */
  readonly handled: number;
  /** Handlers that threw, timeouts excluded. */
  readonly failed: number;
  /** Handlers rejected by `jobTimeoutMs`. */
  readonly timedOut: number;
  /** Nanoseconds. */
  readonly handlerDuration: HistogramSnapshot;
}

export interface QueueStatsReport {
  readonly jobs: readonly JobStats[];
  readonly published: number;
  readonly handled: number;
  readonly since: string;
}

interface Series {
  readonly queue: string;
  readonly name: string;
  published: number;
  publishErrors: number;
  publishDuration: Durations | undefined;
  handled: number;
  failed: number;
  timedOut: number;
  handlerDuration: Durations | undefined;
}

const series = (queue: string, name: string): Series => ({
  queue,
  name,
  published: 0,
  publishErrors: 0,
  publishDuration: undefined,
  handled: 0,
  failed: 0,
  timedOut: 0,
  handlerDuration: undefined,
});

const EMPTY: HistogramSnapshot = Object.freeze({ count: 0 });

/**
 * How the queue is behaving, by queue and job name.
 *
 * Two seams, both in the container that bound this: `JobPublisher.publish` for the
 * enqueue, and the `JobDispatcher` that container builds to consume, whether from
 * `consume: true` or from `WorkerFactory`. A histogram is allocated per side on
 * first use, so a web process that only publishes holds no handler histograms.
 *
 * **A forked handler is invisible here, and that covers most of them.** `isolation`
 * defaults to `'process'`, so a queue carrying a `@JobHandler({ background: true })`
 * runs in a child that boots a container this one cannot see. So does a dedicated
 * worker process, which keeps its own. What this reports is the publish side plus
 * whatever handlers ran in this process.
 *
 * A job name comes from the caller, so series are capped: {@link CappedSeries}.
 *
 * Bound only when `metrics: true`.
 */
export class QueueMetrics {
  readonly #series = new CappedSeries(series);
  #published = 0;
  #handled = 0;
  #since = new Date();

  observePublish(
    queue: string,
    name: string,
    durationNs: number,
    failed = false,
  ): void {
    const stats = this.#series.for(queue, name);
    this.#published += 1;
    stats.published += 1;
    if (failed) stats.publishErrors += 1;
    (stats.publishDuration ??= new Durations()).record(durationNs);
  }

  observeHandled(
    queue: string,
    name: string,
    durationNs: number,
    outcome: JobOutcome,
  ): void {
    const stats = this.#series.for(queue, name);
    this.#handled += 1;
    stats.handled += 1;
    if (outcome === JobOutcome.FAILED) stats.failed += 1;
    else if (outcome === JobOutcome.TIMED_OUT) stats.timedOut += 1;
    (stats.handlerDuration ??= new Durations()).record(durationNs);
  }

  snapshot(): QueueStatsReport {
    const jobs: JobStats[] = [];
    for (const stats of this.#series.values()) {
      jobs.push({
        queue: stats.queue,
        name: stats.name,
        published: stats.published,
        publishErrors: stats.publishErrors,
        publishDuration: stats.publishDuration?.snapshot() ?? EMPTY,
        handled: stats.handled,
        failed: stats.failed,
        timedOut: stats.timedOut,
        handlerDuration: stats.handlerDuration?.snapshot() ?? EMPTY,
      });
    }
    return {
      jobs,
      published: this.#published,
      handled: this.#handled,
      since: this.#since.toISOString(),
    };
  }

  reset(): void {
    this.#series.clear();
    this.#published = 0;
    this.#handled = 0;
    this.#since = new Date();
  }
}
