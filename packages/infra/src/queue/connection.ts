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
     * `duplicate()` returns, because Bun does not fire `onconnect` on a natively
     * duplicated client:
     *
     * ```
     * fresh client   -> onconnect fired: true
     * duplicated raw -> onconnect fired: false | connected: true
     * ```
     *
     * Which decides whether a dropped socket ever comes back. bullmq 6.0.5 built
     * its replacement with `new (this.raw.constructor)(this.raw.url)`, so the
     * constructor above was the whole fix; 6.3.4 rebuilds through `_duplicateRaw`,
     * which prefers `src.duplicate()`, and the caret on its peer range is enough
     * to land an app on that.
     *
     * The initial connection survives either way - the adapter's `connect()` calls
     * `_handleConnected()` itself. `_scheduleReconnect` does not: it wires
     * `onconnect` and calls `connect()` on the raw client, so with a native
     * duplicate `_handleConnected()` never runs. The adapter never re-sends
     * `CLIENT SETNAME`, never flips `ready`, and never resolves `readying`, while
     * the socket underneath is fine - measured against a real Redis as a
     * connection sitting at `tot-cmds=1 cmd=hello`, idle for 20 hours, with the
     * worker awaiting readiness and never issuing another `BZPOPMIN`.
     *
     * Nothing on that path rejects, so no `error` is emitted and no `Worker error
     * on <queue>` is logged: the queue stops consuming silently and stays that way
     * until the process restarts, which drains the backlog and then wedges again
     * on the next dropped socket.
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
  readonly #open: { adapter: IRedisClient; raw: Bun.RedisClient }[] = [];

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
    const adapter = this.#handleErrors(createBunRedisClient(raw));
    this.#open.push({ adapter, raw });
    return adapter;
  }

  /** How many sockets this connection currently holds open. */
  get open(): number {
    return this.#open.filter(({ raw }) => raw.connected).length;
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
    for (const { adapter, raw } of this.#open) {
      adapter.disconnect();
      raw.close();
    }
    this.#open.length = 0;
  }
}
