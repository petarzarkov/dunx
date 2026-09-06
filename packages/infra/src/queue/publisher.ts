import { Logger, type OnShutdown } from '@dunx/core';
import { Queue, type Job, type JobsOptions } from 'bullmq';
import { QueueConnection } from './connection.js';
import { describeJob } from './discover.js';
import { QueueOptions } from './options.js';

/**
 * Distinct queue names past which they are more likely derived from data than
 * written by hand. A warning, not a cap: `Queue.close()` is async, so evicting one
 * races a publish. See `module.test.ts`.
 */
const WARN_AT_QUEUES = 64;

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
   *
   * **Held once opened, and `name` is whatever the caller passed**, so a name
   * derived from data reserves a queue and a Redis connection per value, until
   * shutdown. Put the tenant in the payload, not the queue name.
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
