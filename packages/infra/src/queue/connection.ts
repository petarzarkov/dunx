import { Logger, type OnShutdown } from '@dunx/core';
import { createBunRedisClient, type IRedisClient } from 'bullmq';
import { QueueOptions } from './options.js';

/**
 * The class bullmq is handed a client of, rather than `Bun.RedisClient` itself.
 * Its adapter rebuilds the client with `new (this.raw.constructor)(this.raw.url)`
 * on `duplicate()` and on reconnect, which drops both the options (so
 * `maxRetries: 0` covers the first socket only) and the url (`Bun.RedisClient`
 * exposes none, so a replacement silently resolves Bun's default server).
 *
 * A subclass carrying the url and reapplying the options fixes both.
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

    /**
     * A newly **constructed** client, rather than the one Bun's native
     * `duplicate()` returns. That one resolves already connected, so a caller
     * assigning `onconnect` after it never sees the event, and bullmq rebuilds a
     * dropped socket through `_duplicateRaw`, which prefers `duplicate()`.
     *
     * A clean `CLIENT KILL` does not reproduce a wedge on bullmq 6.3.4, whose
     * `connect()` runs `_handleConnected()` itself for an already-connected raw
     * client. Kept for the production trigger that did wedge, which a reset does
     * not simulate. Measured both ways in docs/architecture/queues.md.
     */
    override duplicate(): Promise<Bun.RedisClient> {
      return Promise.resolve(new BoundRedisClient(url));
    }
  };
};

/**
 * Where the ioredis boundary is drawn. bullmq takes either a connection
 * description it builds a client from, or a built client implementing
 * `IRedisClient`; dunx does the second over `Bun.RedisClient`, so every byte of
 * queue traffic is Bun's and dunx never imports ioredis.
 *
 * ioredis remains a load-time requirement of bullmq's barrel. See
 * docs/architecture/queues.md.
 */
export class QueueConnection implements OnShutdown {
  readonly #options: QueueOptions;
  readonly #logger: Logger;
  readonly #client: new (url?: string) => Bun.RedisClient;
  /** Every adapter this connection handed out or bullmq derived from one. */
  readonly #open: IRedisClient[] = [];

  constructor(options: QueueOptions, logger: Logger) {
    this.#options = options;
    this.#logger = logger;
    this.#client = boundClientClass(options);
  }

  /**
   * Every adapter client gets an `error` listener, the duplicates included. The
   * adapter emits `error` on an unexpected close, and an `error` event with no
   * listener throws - Bun then prints raw multi-line `RedisError` blocks past the
   * bound Logger. Duplicates are fresh emitters, so `duplicate()` is wrapped;
   * `QueueBase` forwards connection errors onto the `Queue`, so that needs one too.
   */
  #handleErrors(adapter: IRedisClient): IRedisClient {
    // Recorded here rather than in `client()`, which is what gives a duplicate a
    // teardown owner: bullmq calls `duplicate()` for anything it may block on -
    // `Worker` and `QueueEvents` each once, `Queue` never - and that socket used
    // to belong to nobody. Duplicates of duplicates land here too.
    this.#open.push(adapter);

    adapter.on('error', (error: unknown) => {
      this.#logger.warn('the queue connection reported an error', error);
    });

    /**
     * The arguments are forwarded. Calling `duplicate.call(adapter)` with none
     * silently broke `Queue.getWorkers()`: the Bun adapter takes the connection
     * name only through `duplicate({ connectionName })`, and `getWorkers()`
     * matches that name in `CLIENT LIST`, so a live worker reported as absent.
     *
     * `unknown[]` rather than `readonly unknown[]`: `Function.apply` declares a
     * mutable array.
     */
    const derived = adapter as {
      duplicate?: (...args: unknown[]) => IRedisClient;
    };
    const duplicate = derived.duplicate;
    if (typeof duplicate === 'function') {
      derived.duplicate = (...args: unknown[]): IRedisClient =>
        this.#handleErrors(duplicate.apply(adapter, args));
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
    return this.#handleErrors(createBunRedisClient(raw));
  }

  /**
   * The socket an adapter holds, if it has one yet.
   *
   * Read at teardown rather than captured when the client is handed out. A
   * duplicate is constructed with no `raw` at all - bullmq builds it from a
   * `rawFactory` on first connect, which is how it stopped sending duplicates to
   * the default server (taskforcesh/bullmq#4582) - so there is nothing to
   * capture at the time the wrapper sees it. Measured: `undefined` immediately,
   * a `Bun.RedisClient` once connected.
   */
  #socketOf(adapter: IRedisClient): Bun.RedisClient | undefined {
    const { raw } = adapter as { raw?: unknown };
    return raw instanceof Bun.RedisClient ? raw : undefined;
  }

  /** How many sockets this connection currently holds open, duplicates included. */
  get open(): number {
    return this.#open.filter(
      (adapter) => this.#socketOf(adapter)?.connected === true,
    ).length;
  }

  /**
   * Closes every client handed out, last in reverse-order teardown. Both halves,
   * in this order: `disconnect()` on the adapter first, since bullmq reads an
   * untold close as a blip and would rebuild the connection being torn down; then
   * `close()` on the socket, which `disconnect()` skips for a client that never
   * connected and which would otherwise keep the process alive.
   *
   * This does not cure the SIGTERM hang in
   * internal/notes/roadmap/queue-shutdown-sigterm.md.
   */
  onShutdown(): void {
    // Drained first: `disconnect()` can schedule a reconnect, and a reconnect
    // duplicates, so iterating the live array could append to what it is walking.
    for (const adapter of this.#open.splice(0)) {
      adapter.disconnect();
      // `disconnect()` is raw-safe and closes nothing for a duplicate that never
      // connected, so this is the half that releases a socket either way.
      this.#socketOf(adapter)?.close();
    }
  }
}
