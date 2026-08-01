import type { Job } from 'bullmq';
import { describeJob, type DiscoveredJob } from './discover.js';
import { QueueError, QueueErrorCode } from './errors.js';

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

  constructor(jobs: readonly DiscoveredJob[], timeoutMs?: number) {
    this.#timeoutMs = timeoutMs;
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
   * cause is a worker deployed before the handler that serves it.
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

    if (this.#timeoutMs === undefined) return found.handler(job);
    return this.#withTimeout(job, found, this.#timeoutMs);
  }

  async #withTimeout(
    job: Job,
    found: DiscoveredJob,
    timeoutMs: number,
  ): Promise<unknown> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new QueueError(
            QueueErrorCode.TIMED_OUT,
            `${found.provider}.${found.method}() exceeded jobTimeoutMs ` +
              `(${timeoutMs}ms) handling ${describeJob(job)}.`,
          ),
        );
      }, timeoutMs);
    });

    try {
      return await Promise.race([found.handler(job), expiry]);
    } finally {
      // Otherwise a handler that finished in time leaves a pending timer, and the
      // process cannot exit until the longest one fires.
      clearTimeout(timer);
    }
  }
}
