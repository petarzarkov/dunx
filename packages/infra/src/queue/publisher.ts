import { Logger, type OnShutdown } from '@dunx/core';
import { Queue, type Job, type JobsOptions } from 'bullmq';
import { QueueConnection } from './connection.js';
import { describeJob } from './discover.js';
import { QueueMetrics } from './metrics.js';
import { QueueOptions } from './options.js';
import type { JobTracing } from './tracing.js';

/**
 * Distinct queue names past which they are more likely derived from data than
 * written by hand. A warning, not a hard stop: see `MAX_OPEN_QUEUES`.
 */
const WARN_AT_QUEUES = 64;

/**
 * The most distinct queues held open at once. Past this, the least recently used
 * queue is closed and evicted, so a name derived from data cannot reserve a queue
 * and a Redis connection per value without bound. High enough that an app with
 * hundreds of legitimate queues never touches it.
 */
const MAX_OPEN_QUEUES = 1024;

/**
 * Enqueues jobs. The other half of the split the dispatcher is: nothing here knows
 * how a job runs, and nothing in the dispatcher knows how one arrives - so a web
 * process imports this and never opens a worker.
 *
 * bullmq's `Queue` is the return type rather than something wrapped: it already
 * has `addBulk`, `upsertJobScheduler`, `getJobCounts`, `drain` and the rest, and
 * restating any of that would be a staler copy of its documentation.
 */
export class JobPublisher implements OnShutdown {
  readonly #connection: QueueConnection;
  readonly #options: QueueOptions;
  readonly #logger: Logger;
  readonly #metrics: QueueMetrics | undefined;
  readonly #tracing: JobTracing | undefined;
  readonly #maxOpen: number;
  readonly #queues = new Map<string, Queue>();

  constructor(
    connection: QueueConnection,
    options: QueueOptions,
    logger: Logger,
    metrics?: QueueMetrics,
    tracing?: JobTracing,
    maxOpen = MAX_OPEN_QUEUES,
  ) {
    this.#connection = connection;
    this.#options = options;
    this.#logger = logger;
    this.#metrics = metrics;
    this.#tracing = tracing;
    this.#maxOpen = maxOpen;
  }

  /** The names this publisher has opened a queue for so far. */
  get opened(): readonly string[] {
    return [...this.#queues.keys()];
  }

  /**
   * The bullmq `Queue` for `name`, memoised.
   *
   * Opened on first use rather than declared up front: a queue is a key prefix,
   * not a resource to reserve, so there is nothing for a registration step to
   * validate and nothing gained by holding a socket for a queue nobody publishes
   * to.
   *
   * `name` is whatever the caller passed, so a name derived from data reserves a
   * queue and a Redis connection per value. That is what `maxOpen` bounds: past it,
   * the least recently used queue is closed and evicted. Put the tenant in the
   * payload, not the queue name.
   */
  queue(name: string): Queue {
    const existing = this.#queues.get(name);
    if (existing) {
      // Refresh recency so eviction takes the least recently used, not the
      // oldest-opened.
      this.#queues.delete(name);
      this.#queues.set(name, existing);
      return existing;
    }

    const created = new Queue(name, {
      connection: this.#connection.client(),
      prefix: this.#options.prefix,
      ...(this.#options.defaultJobOptions && {
        defaultJobOptions: this.#options.defaultJobOptions,
      }),
    });

    // `QueueBase` forwards its connection's errors onto the Queue, and an 'error'
    // event with no listener throws rather than being ignored - so an unreachable
    // broker wrote raw RedisError dumps to stderr, bypassing this Logger, on top
    // of rejecting the publish. `Worker` has had this listener all along; the
    // Queue did not.
    created.on('error', (error: unknown) => {
      this.#logger.warn(`the "${name}" queue reported an error`, error);
    });

    this.#queues.set(name, created);
    // Exactly once, on the crossing, so a busy publisher does not repeat itself.
    if (this.#queues.size === WARN_AT_QUEUES) {
      this.#logger.warn(
        `${WARN_AT_QUEUES} distinct queue names have been opened, each holding a ` +
          'Redis connection until shutdown. A queue name belongs to the ' +
          "application's vocabulary; if these are derived from data, put that in " +
          'the job payload and publish to one queue instead.',
      );
    }
    this.#evict();
    return created;
  }

  /** Closes the least recently used queue once the cap is crossed. */
  #evict(): void {
    if (this.#queues.size <= this.#maxOpen) return;
    const oldest = this.#queues.keys().next().value;
    if (oldest === undefined) return;
    const queue = this.#queues.get(oldest);
    this.#queues.delete(oldest);
    void queue?.close();
  }

  /**
   * `queue(...).add(...)`, with the enqueue recorded on the logger and, when
   * `metrics: true`, timed on `QueueMetrics`. A caller reaching for `queue(name)`
   * and calling `add`, `addBulk` or `upsertJobScheduler` on it goes round this and
   * is counted nowhere, and opens no PRODUCER span.
   */
  async publish<T>(
    queue: string,
    name: string,
    data: T,
    options?: JobsOptions,
  ): Promise<Job<T>> {
    const metrics = this.#metrics;
    const started = metrics === undefined ? 0 : Bun.nanoseconds();
    const tracing = this.#tracing;
    let job: Job;
    try {
      job =
        tracing === undefined
          ? await this.queue(queue).add(name, data, options)
          : await tracing.publish(queue, name, options, (traced) =>
              this.queue(queue).add(name, data, traced),
            );
    } catch (error) {
      metrics?.observePublish(queue, name, Bun.nanoseconds() - started, true);
      throw error;
    }
    metrics?.observePublish(queue, name, Bun.nanoseconds() - started);
    this.#logger.debug(`Published job ${describeJob(job)}`);
    return job as Job<T>;
  }

  async onShutdown(): Promise<void> {
    await Promise.all([...this.#queues.values()].map((queue) => queue.close()));
    this.#queues.clear();
  }
}
