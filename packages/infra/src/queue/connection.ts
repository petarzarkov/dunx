import type { OnShutdown } from '@dunx/core';
import { createBunRedisClient, type IRedisClient } from 'bullmq';
import { QueueOptions } from './options.js';

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
 * declaring it an optional peer. See docs/ARCHITECTURE.md, "Queues".
 */
export class QueueConnection implements OnShutdown {
  readonly #options: QueueOptions;
  readonly #clients: Bun.RedisClient[] = [];

  constructor(options: QueueOptions) {
    this.#options = options;
  }

  /**
   * A fresh client. One per bullmq object rather than one shared: a `Worker`
   * blocks on `BZPOPMIN`, and bullmq duplicates whatever it is given to get a
   * connection it may block on, so sharing would only add a duplicate.
   */
  client(): IRedisClient {
    const raw = new Bun.RedisClient(
      this.#options.url,
      this.#options.connection,
    );
    this.#clients.push(raw);
    const adapter = createBunRedisClient(raw);
    // bullmq drops its own error listener when it closes a connection it did not
    // create. Closing the socket after that emits 'error' on a listener-less
    // EventEmitter, which throws rather than being ignored - so shutdown would
    // fail on its last step. Measured on bullmq 6.0.5.
    adapter.on('error', () => undefined);
    return adapter;
  }

  /** How many sockets this connection currently holds open. */
  get open(): number {
    return this.#clients.filter((client) => client.connected).length;
  }

  /**
   * Closes every client handed out. Constructed before anything that uses it, so
   * reverse-order teardown runs this last - after the publisher has closed its
   * queues and the worker has drained.
   */
  onShutdown(): void {
    for (const client of this.#clients) client.close();
    this.#clients.length = 0;
  }
}
