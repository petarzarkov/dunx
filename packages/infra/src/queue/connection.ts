import { Logger, type OnShutdown } from '@dunx/core';
import { createBunRedisClient, type IRedisClient } from 'bullmq';
import { QueueOptions } from './options.js';

/**
 * The class bullmq is handed a client of, rather than `Bun.RedisClient` itself.
 *
 * bullmq's adapter does not keep the client it was given: `duplicate()` (a
 * `Worker` blocks on its own connection) and its auto-reconnect both build a
 * replacement with `new (this.raw.constructor)(this.raw.url)`. Two things go
 * wrong there, and one subclass fixes both:
 *
 * - **The options are dropped.** `createBunRedisClient(client, opts)` takes only
 *   `lazyConnect`, so a replacement gets Bun's defaults - unbounded retries - and
 *   the `maxRetries: 0` this package chose applies to the first socket only.
 * - **The url is dropped too.** `Bun.RedisClient` exposes no `url` property on Bun
 *   1.3.14, so `this.raw.url` is `undefined` and the replacement resolves Bun's
 *   default (`$VALKEY_URL`, `$REDIS_URL`, `valkey://localhost:6379`) - a different
 *   server than the one configured, silently.
 *
 * A subclass that carries the url and reapplies the options makes both
 * constructions come out the same as the first one.
 */
const boundClientClass = (
  options: QueueOptions,
): new (url?: string) => Bun.RedisClient => {
  const { url, connection } = options;
  return class BoundRedisClient extends Bun.RedisClient {
    readonly url: string = url;

    constructor(given?: string) {
      super(given ?? url, connection);
    }
  };
};

/**
 * Where the ioredis boundary is actually drawn.
 *
 * bullmq accepts either a connection *description*, which it hands to a client it
 * constructs itself, or an already-built client implementing its `IRedisClient`
 * adapter interface. dunx does the second, over `Bun.RedisClient` and bullmq's own
 * `createBunRedisClient` - so every byte of queue traffic goes through Bun's
 * client, and dunx neither imports nor constructs ioredis. `@dunx/infra/redis` is
 * unaffected and unshared: a queue's sockets are its own.
 *
 * ioredis is still a load-time requirement of bullmq's barrel - measured on
 * bullmq 6.0.5, which statically imports it from `redis-connection` despite
 * declaring it an optional peer. See docs/architecture/queues.md, "Queues".
 */
export class QueueConnection implements OnShutdown {
  readonly #options: QueueOptions;
  readonly #logger: Logger;
  readonly #client: new (url?: string) => Bun.RedisClient;
  readonly #open: { adapter: IRedisClient; raw: Bun.RedisClient }[] = [];

  constructor(options: QueueOptions, logger: Logger) {
    this.#options = options;
    this.#logger = logger;
    this.#client = boundClientClass(options);
  }

  /**
   * Every adapter client gets an `error` listener, including the ones bullmq
   * derives with `duplicate()`.
   *
   * `bun-redis-client.js` does `this.emit('error', error)` on an unexpected close.
   * An `error` event with no listener throws, and Bun prints the raw `RedisError`
   * to stderr - two unstructured multi-line blocks per failed publish, bypassing
   * the bound Logger entirely, in an app whose logging is otherwise JSON.
   *
   * Attaching to the client dunx hands over was not enough: bullmq duplicates it
   * for connections it may block on, and the duplicate is a fresh emitter. So
   * `duplicate()` is wrapped to attach to whatever it returns.
   *
   * This covers the clients. The other half was the `Queue` itself: `QueueBase`
   * forwards its connection's errors onto the Queue, so the object `JobPublisher`
   * constructs needed a listener too. Both are handled now and an unreachable
   * broker writes nothing raw.
   */
  #handleErrors(adapter: IRedisClient): IRedisClient {
    adapter.on('error', (error: unknown) => {
      this.#logger.warn('the queue connection reported an error', error);
    });

    const derived = adapter as { duplicate?: () => IRedisClient };
    const duplicate = derived.duplicate;
    if (typeof duplicate === 'function') {
      derived.duplicate = (): IRedisClient =>
        this.#handleErrors(duplicate.call(adapter));
    }
    return adapter;
  }

  /**
   * A fresh client. One per bullmq object rather than one shared: a `Worker`
   * blocks on `BZPOPMIN`, and bullmq duplicates whatever it is given to get a
   * connection it may block on, so sharing would only add a duplicate.
   */
  client(): IRedisClient {
    const raw = new this.#client(this.#options.url);
    // Handled before it is handed over: bullmq drops its own error listener when
    // it closes a connection it did not create, and an 'error' on a listener-less
    // emitter throws rather than being ignored - which used to fail shutdown on
    // its last step. Measured on bullmq 6.0.5.
    const adapter = this.#handleErrors(createBunRedisClient(raw));
    this.#open.push({ adapter, raw });
    return adapter;
  }

  /** How many sockets this connection currently holds open. */
  get open(): number {
    return this.#open.filter(({ raw }) => raw.connected).length;
  }

  /**
   * Closes every client handed out. Constructed before anything that uses it, so
   * reverse-order teardown runs this last - after the publisher has closed its
   * queues and the worker has drained.
   *
   * Both halves are needed, in this order. `disconnect()` on the **adapter**
   * first: bullmq treats a socket that closed without being told to as a blip and
   * schedules a reconnect, so closing the socket underneath it would rebuild the
   * connection being torn down. Then `close()` on the socket, because
   * `disconnect()` skips it for a client that never finished connecting, and an
   * unclosed one keeps the process alive.
   *
   * This does **not** cure the SIGTERM hang in docs/roadmap - `disconnect()`
   * returns early once the connection has already dropped, which is exactly when
   * a reconnect is pending. That one is upstream's; see
   * docs/roadmap/queue-shutdown-sigterm.md.
   */
  onShutdown(): void {
    for (const { adapter, raw } of this.#open) {
      adapter.disconnect();
      raw.close();
    }
    this.#open.length = 0;
  }
}
