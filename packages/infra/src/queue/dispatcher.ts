import type { App, InjectionToken, ResolvedModule } from '@dunx/core';
import type { Job } from 'bullmq';
import { describeJob, type DiscoveredJob } from './discover.js';
import { QueueError, QueueErrorCode } from './errors.js';
import { JobOutcome, QueueMetrics } from './metrics.js';
import { withTimeout } from '../with-timeout.js';

/**
 * Whether the graph binds this token, asked of the graph rather than by resolving
 * it. An unbound class self-binds into whichever scope asks first, so `app.get`
 * answers yes to everything.
 */
export const declares = (
  modules: readonly ResolvedModule[],
  token: InjectionToken<unknown>,
): boolean =>
  modules.some((module) =>
    (module.options.providers ?? []).some(
      (entry) => typeof entry !== 'function' && entry.token === token,
    ),
  );

/**
 * The `QueueMetrics` the graph bound, or `undefined` when `metrics` was off. Off,
 * the dispatcher takes none at all, so a handler pays for no clock.
 */
export const metricsIn = (
  modules: readonly ResolvedModule[],
  app: App,
): QueueMetrics | undefined =>
  declares(modules, QueueMetrics) ? app.get(QueueMetrics) : undefined;

const outcomeOf = (error: unknown): JobOutcome =>
  error instanceof QueueError && error.code === QueueErrorCode.TIMED_OUT
    ? JobOutcome.TIMED_OUT
    : JobOutcome.FAILED;

/**
 * Routes an arriving `Job` to the handler discovery found for it.
 *
 * Deliberately separate from the publisher, and from the thing that opens bullmq
 * `Worker`s: dispatch is pure lookup plus invocation, so it is testable without a
 * server and reusable by anything that gets handed a job.
 */
export class JobDispatcher {
  readonly #byQueue = new Map<string, Map<string, DiscoveredJob>>();
  readonly #timeoutMs: number | undefined;
  readonly #metrics: QueueMetrics | undefined;

  constructor(
    jobs: readonly DiscoveredJob[],
    timeoutMs?: number,
    metrics?: QueueMetrics,
  ) {
    this.#timeoutMs = timeoutMs;
    this.#metrics = metrics;
    for (const job of jobs) {
      let queue = this.#byQueue.get(job.queue);
      if (!queue) {
        queue = new Map();
        this.#byQueue.set(job.queue, queue);
      }
      queue.set(job.name, job);
    }
  }

  /** Every queue at least one handler consumes from. */
  get queues(): readonly string[] {
    return [...this.#byQueue.keys()];
  }

  handlersFor(queue: string): readonly DiscoveredJob[] {
    return [...(this.#byQueue.get(queue)?.values() ?? [])];
  }

  /**
   * The handler's own return value, which bullmq stores as the job's result.
   *
   * An unclaimed job name throws rather than being acknowledged: bullmq then
   * retries it under the job's own `attempts`, which is the right outcome when the
   * cause is a worker deployed before the handler that serves it. It is not timed
   * either: no handler ran, so there is nothing whose duration it would be.
   */
  async dispatch(job: Job): Promise<unknown> {
    const found = this.#byQueue.get(job.queueName)?.get(job.name);
    if (!found) {
      const known = this.handlersFor(job.queueName).map((entry) => entry.name);
      throw new QueueError(
        QueueErrorCode.UNKNOWN_JOB,
        `No handler for ${describeJob(job)}. This worker serves ` +
          `${known.length > 0 ? known.join(', ') : 'nothing'} on that queue.`,
      );
    }

    const metrics = this.#metrics;
    if (metrics === undefined) return this.#invoke(job, found);
    return this.#observed(job, found, metrics);
  }

  #invoke(job: Job, found: DiscoveredJob): unknown {
    if (this.#timeoutMs === undefined) return found.handler(job);
    const timeoutMs = this.#timeoutMs;
    return withTimeout(
      () => found.handler(job),
      timeoutMs,
      () =>
        new QueueError(
          QueueErrorCode.TIMED_OUT,
          `${found.provider}.${found.method}() exceeded jobTimeoutMs ` +
            `(${timeoutMs}ms) handling ${describeJob(job)}.`,
        ),
    );
  }

  async #observed(
    job: Job,
    found: DiscoveredJob,
    metrics: QueueMetrics,
  ): Promise<unknown> {
    const started = Bun.nanoseconds();
    try {
      const value = await this.#invoke(job, found);
      metrics.observeHandled(
        job.queueName,
        job.name,
        Bun.nanoseconds() - started,
        JobOutcome.COMPLETED,
      );
      return value;
    } catch (error) {
      metrics.observeHandled(
        job.queueName,
        job.name,
        Bun.nanoseconds() - started,
        outcomeOf(error),
      );
      throw error;
    }
  }
}
