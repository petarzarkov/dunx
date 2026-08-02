import type { OnShutdown } from '@dunx/core';
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
  readonly #client: new (url?: string) => Bun.RedisClient;
  readonly #open: { adapter: IRedisClient; raw: Bun.RedisClient }[] = [];

  constructor(options: QueueOptions) {
    this.#options = options;
    this.#client = boundClientClass(options);
  }

  /**
   * A fresh client. One per bullmq object rather than one shared: a `Worker`
   * blocks on `BZPOPMIN`, and bullmq duplicates whatever it is given to get a
   * connection it may block on, so sharing would only add a duplicate.
   */
  client(): IRedisClient {
    const raw = new this.#client(this.#options.url);
    const adapter = createBunRedisClient(raw);
    // bullmq drops its own error listener when it closes a connection it did not
    // create. Closing the socket after that emits 'error' on a listener-less
    // EventEmitter, which throws rather than being ignored - so shutdown would
    // fail on its last step. Measured on bullmq 6.0.5.
    adapter.on('error', () => undefined);
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
