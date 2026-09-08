import { Logger, type OnShutdown } from '@dunx/core';
import { QueueEvents } from 'bullmq';
import { QueueConnection } from './connection.js';
import { QueueOptions } from './options.js';

/**
 * Distinct queues past which the names are more likely derived from data than
 * written by hand, matching `JobPublisher`. Each one holds a blocking socket.
 */
const WARN_AT_QUEUES = 64;

/**
 * How long one stream gets to close before shutdown stops waiting on it.
 *
 * `QueueEvents.close()` against an unreachable broker neither resolves nor
 * rejects: the blocking read keeps reconnecting on a growing backoff, past
 * `autoReconnect: false`, so an unbounded await hung the process on its way out.
 * Measured on bullmq 6.3.4. `QueueConnection.onShutdown` closes the raw socket
 * after this regardless, so the wait is a courtesy rather than the mechanism.
 */
const CLOSE_TIMEOUT_MS = 2_000;

/**
 * bullmq's `QueueEvents`, connected the way everything else here is.
 *
 * A process that publishes a job had no way to learn it finished. The handler
 * runs elsewhere, and `returnvalue` on the handle `add()` returned is filled at
 * load time, so the only option left was polling `getState()` on a timer. bullmq
 * broadcasts completion over Redis pub/sub and `Job.waitUntilFinished(events,
 * ttl)` already waits on it; nothing exposed a correctly-connected `QueueEvents`
 * to pass it.
 *
 * So this contributes the two things bullmq cannot know: a client over
 * `Bun.RedisClient`, and a lifetime that ends before those sockets close. The
 * waiting stays bullmq's, and `events()` returns its own object, for the reason
 * `JobPublisher.queue()` returns a bullmq `Queue`.
 */
export class JobEvents implements OnShutdown {
  readonly #connection: QueueConnection;
  readonly #options: QueueOptions;
  readonly #logger: Logger;
  readonly #events = new Map<string, QueueEvents>();

  constructor(
    connection: QueueConnection,
    options: QueueOptions,
    logger: Logger,
  ) {
    this.#connection = connection;
    this.#options = options;
    this.#logger = logger;
  }

  /** The names this has opened an event stream for so far. */
  get opened(): readonly string[] {
    return [...this.#events.keys()];
  }

  /**
   * The `QueueEvents` for `name`, memoised.
   *
   * Opened on first use for the reason `JobPublisher.queue()` is, and one more:
   * `autorun` defaults to true and starts a blocking `XREAD` in the constructor,
   * so a process that never waits on a job holds no blocking socket.
   */
  events(name: string): QueueEvents {
    const existing = this.#events.get(name);
    if (existing) return existing;

    const created = new QueueEvents(name, {
      connection: this.#connection.client(),
      prefix: this.#options.prefix,
    });

    // For the reason the `Queue` has one: `QueueBase` forwards its connection's
    // errors onto the object, and an 'error' with no listener throws rather than
    // being ignored, so an unreachable broker wrote raw dumps past this Logger.
    created.on('error', (error: unknown) => {
      this.#logger.warn(`the "${name}" queue events reported an error`, error);
    });

    this.#events.set(name, created);
    if (this.#events.size === WARN_AT_QUEUES) {
      this.#logger.warn(
        `${WARN_AT_QUEUES} distinct queues are being watched, each holding a ` +
          'blocking Redis connection until shutdown. Put a value derived from ' +
          'data in the job payload, not in the queue name.',
      );
    }
    return created;
  }

  /**
   * Closes every stream opened. Bound after `QueueConnection`, so reverse-order
   * teardown runs this before the sockets it borrowed are closed under it.
   *
   * Cleared first, so a `close()` that never settles cannot be waited on twice.
   */
  async onShutdown(): Promise<void> {
    const pending = [...this.#events.entries()];
    this.#events.clear();
    await Promise.all(pending.map((entry) => this.#close(entry[0], entry[1])));
  }

  /** Bounded, and never rejecting: one stream that will not close must not stop
   * the rest of shutdown, which is what closes the socket under it. */
  async #close(name: string, events: QueueEvents): Promise<void> {
    const timedOut = Symbol('timed out');
    try {
      const outcome = await Promise.race([
        events.close(),
        Bun.sleep(CLOSE_TIMEOUT_MS).then(() => timedOut),
      ]);
      if (outcome === timedOut) {
        this.#logger.warn(
          `the "${name}" queue events did not close within ${CLOSE_TIMEOUT_MS} ms`,
        );
      }
    } catch (error) {
      this.#logger.warn(`the "${name}" queue events failed to close`, error);
    }
  }
}
