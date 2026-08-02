import { Logger, type OnShutdown } from '@dunx/core';
import { Queue, type Job, type JobsOptions } from 'bullmq';
import { QueueConnection } from './connection.js';
import { describeJob } from './discover.js';
import { QueueOptions } from './options.js';

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
  readonly #queues = new Map<string, Queue>();

  constructor(
    connection: QueueConnection,
    options: QueueOptions,
    logger: Logger,
  ) {
    this.#connection = connection;
    this.#options = options;
    this.#logger = logger;
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
   */
  queue(name: string): Queue {
    const existing = this.#queues.get(name);
    if (existing) return existing;

    const created = new Queue(name, {
      connection: this.#connection.client(),
      prefix: this.#options.prefix,
      ...(this.#options.defaultJobOptions && {
        defaultJobOptions: this.#options.defaultJobOptions,
      }),
    });
    this.#queues.set(name, created);
    return created;
  }

  /** `queue(...).add(...)`, with the enqueue recorded on the logger. */
  async publish<T>(
    queue: string,
    name: string,
    data: T,
    options?: JobsOptions,
  ): Promise<Job<T>> {
    const job = await this.queue(queue).add(name, data, options);
    this.#logger.debug(`Published job ${describeJob(job)}`);
    return job as Job<T>;
  }

  async onShutdown(): Promise<void> {
    await Promise.all([...this.#queues.values()].map((queue) => queue.close()));
    this.#queues.clear();
  }
}
