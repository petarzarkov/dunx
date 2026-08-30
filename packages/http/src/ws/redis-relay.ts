import { AppError } from '@dunx/core';
import { WsRelay } from './relay.js';

/**
 * The schemes `Bun.RedisClient` accepts. Checked here because Bun takes any string
 * and only fails later, at connect time, as an opaque `Connection closed` - which
 * an absence-tolerant relay would swallow, turning a typo into silent single-node
 * fan-out.
 */
const PROTOCOLS: readonly string[] = [
  'redis:',
  'rediss:',
  'valkey:',
  'valkeys:',
  'redis+tls:',
  'redis+unix:',
  'redis+tls+unix:',
];

/** The same fallback chain `Bun.RedisClient` uses when given no URL. */
export const defaultRelayUrl = (): string =>
  process.env['VALKEY_URL'] ??
  process.env['REDIS_URL'] ??
  'redis://localhost:6379';

export interface RedisRelayOptions {
  /** @default `$VALKEY_URL`, `$REDIS_URL`, then `redis://localhost:6379` */
  readonly url?: string;
  /**
   * Bun's reconnection budget. `0` by default: a `Bun.RedisClient` that never
   * connects keeps a retry timer alive past `close()`, so the process never exits,
   * and a relay is the connection most likely to be absent. Raise it where Redis
   * is a hard requirement.
   *
   * @default 0
   */
  readonly maxRetries?: number;
  /** @default 10000 */
  readonly connectionTimeout?: number;
  readonly tls?: boolean | Bun.TLSOptions;
}

const assertUrl = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new AppError(
      `${JSON.stringify(url)} is not a valid URL for the websocket relay. ` +
        'Expected something like redis://localhost:6379.',
    );
  }
  if (!PROTOCOLS.includes(parsed.protocol)) {
    throw new AppError(
      `Unsupported protocol ${JSON.stringify(parsed.protocol)} in ` +
        `${JSON.stringify(url)}. Expected one of ${PROTOCOLS.join(', ')}.`,
    );
  }
  return url;
};

/**
 * A {@link WsRelay} on `Bun.RedisClient`, a Bun global, so it costs
 * `@dunx/http` no dependency.
 *
 * Two connections: a client in subscriber mode rejects every data command, so the
 * subscription cannot share the publishing socket. Both open lazily, and a failed
 * one is discarded rather than reused.
 */
export class RedisRelay extends WsRelay {
  readonly #url: string;
  readonly #options: Bun.RedisOptions;
  #pub: Bun.RedisClient | undefined;
  #sub: Bun.RedisClient | undefined;
  /** Remembered only so `close()` can leave subscriber mode. See `close()`. */
  #channel: string | undefined;

  constructor(options: RedisRelayOptions = {}) {
    super();
    this.#url = assertUrl(options.url ?? defaultRelayUrl());
    this.#options = {
      maxRetries: options.maxRetries ?? 0,
      ...(options.connectionTimeout !== undefined && {
        connectionTimeout: options.connectionTimeout,
      }),
      ...(options.tls !== undefined && { tls: options.tls }),
    };
  }

  /** The URL with any password removed, for logs and error messages. */
  get url(): string {
    const parsed = new URL(this.#url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  }

  async publish(channel: string, message: string): Promise<number> {
    const client = (this.#pub ??= new Bun.RedisClient(
      this.#url,
      this.#options,
    ));
    try {
      return await client.publish(channel, message);
    } catch (error) {
      if (this.#pub === client) {
        this.#pub = undefined;
        client.close();
      }
      throw error;
    }
  }

  async subscribe(
    channel: string,
    listener: (message: string) => void,
  ): Promise<void> {
    const client = (this.#sub ??= new Bun.RedisClient(
      this.#url,
      this.#options,
    ));
    try {
      // `connect()` before `subscribe()`, and that order is load-bearing too:
      // measured on Bun 1.3.14, a `subscribe()` that cannot reach the server
      // leaves the client holding the event loop open even after `close()` and
      // even with `maxRetries: 0`, so an app pointed at an absent broker would
      // never exit. Failing at `connect()` instead releases cleanly, and says
      // `Connection closed` rather than `Max reconnection attempts reached`.
      await client.connect();
      await client.subscribe(channel, listener);
      this.#channel = channel;
    } catch (error) {
      if (this.#sub === client) {
        this.#sub = undefined;
        client.close();
      }
      throw error;
    }
  }

  /**
   * `UNSUBSCRIBE` before `close()`, and that order is load-bearing: measured on
   * Bun 1.3.14, a `Bun.RedisClient` left in subscriber mode keeps the process
   * alive after `close()`, so an app that shut down cleanly would never exit.
   * Leaving subscriber mode first fixes it. Recorded in docs/bun-apis.md.
   */
  async close(): Promise<void> {
    const sub = this.#sub;
    const channel = this.#channel;
    this.#pub?.close();
    this.#pub = undefined;
    this.#sub = undefined;
    this.#channel = undefined;
    if (!sub) return;
    if (channel !== undefined) {
      try {
        await sub.unsubscribe(channel);
      } catch {
        // A socket that is already gone is not in subscriber mode either, and
        // throwing here would leave the connection below unclosed.
      }
    }
    sub.close();
  }
}
