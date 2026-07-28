import { RedisError, RedisErrorCode } from './errors.js';

/**
 * The URL schemes `Bun.RedisClient` accepts. Taken from the runtime, which throws
 * `Expected url protocol to be one of ...` for anything else.
 */
export const REDIS_PROTOCOLS = Object.freeze([
  'redis:',
  'rediss:',
  'valkey:',
  'valkeys:',
  'redis+tls:',
  'redis+unix:',
  'redis+tls+unix:',
] as const);

export type RedisProtocol = (typeof REDIS_PROTOCOLS)[number];

/** Mirrors `Bun.RedisClient`'s own fallback chain. */
export const defaultRedisUrl = (): string =>
  process.env['VALKEY_URL'] ??
  process.env['REDIS_URL'] ??
  'valkey://localhost:6379';

export interface RedisOptionsInit {
  /** Defaults to `$VALKEY_URL`, `$REDIS_URL`, then `valkey://localhost:6379`. */
  readonly url?: string;
  /** Bound as its own token so a second connection can be injected by name. */
  readonly name?: string;
  /** @default 10000 */
  readonly connectionTimeout?: number;
  /** @default 0 — no timeout */
  readonly idleTimeout?: number;
  /** @default true */
  readonly autoReconnect?: boolean;
  /** @default 10 */
  readonly maxRetries?: number;
  /** @default true */
  readonly enableOfflineQueue?: boolean;
  /** @default true */
  readonly enableAutoPipelining?: boolean;
  readonly tls?: boolean | Bun.TLSOptions;
  /**
   * Run `PING` during `onInit` so an unreachable server fails at boot instead of
   * at the first command. Off by default — a cache should not stop a process
   * from starting.
   *
   * @default false
   */
  readonly eager?: boolean;
}

const assertUrl = (url: string): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new RedisError(
      RedisErrorCode.INVALID_URL,
      `${JSON.stringify(url)} is not a valid URL. Expected something like ` +
        'redis://localhost:6379.',
    );
  }

  // Bun accepts an unparseable string here and only fails later, at connect time,
  // as an opaque "Connection closed" — so both checks happen up front instead.
  if (!(REDIS_PROTOCOLS as readonly string[]).includes(parsed.protocol)) {
    throw new RedisError(
      RedisErrorCode.INVALID_URL,
      `Unsupported protocol ${JSON.stringify(parsed.protocol)} in ` +
        `${JSON.stringify(url)}. Expected one of ${REDIS_PROTOCOLS.join(', ')}.`,
    );
  }

  return url;
};

/**
 * A class, not an interface, so it is a runtime value and can therefore be a
 * constructor parameter type that `@dunx/compiler` can record.
 */
export class RedisOptions {
  readonly url: string;
  readonly name: string | undefined;
  readonly connectionTimeout: number | undefined;
  readonly idleTimeout: number | undefined;
  readonly autoReconnect: boolean | undefined;
  readonly maxRetries: number | undefined;
  readonly enableOfflineQueue: boolean | undefined;
  readonly enableAutoPipelining: boolean | undefined;
  readonly tls: boolean | Bun.TLSOptions | undefined;
  readonly eager: boolean;

  constructor(init: RedisOptionsInit = {}) {
    this.url = assertUrl(init.url ?? defaultRedisUrl());
    this.name = init.name;
    this.connectionTimeout = init.connectionTimeout;
    this.idleTimeout = init.idleTimeout;
    this.autoReconnect = init.autoReconnect;
    this.maxRetries = init.maxRetries;
    this.enableOfflineQueue = init.enableOfflineQueue;
    this.enableAutoPipelining = init.enableAutoPipelining;
    this.tls = init.tls;
    this.eager = init.eager ?? false;
  }

  /** The URL with any password removed, for logs and error messages. */
  get redactedUrl(): string {
    const parsed = new URL(this.url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  }

  /**
   * Only keys the caller actually set are present: under
   * `exactOptionalPropertyTypes` an explicit `undefined` is not the same as an
   * absent key, and Bun applies its own defaults to absent ones.
   */
  toClientOptions(): Bun.RedisOptions {
    return {
      ...(this.connectionTimeout !== undefined && {
        connectionTimeout: this.connectionTimeout,
      }),
      ...(this.idleTimeout !== undefined && { idleTimeout: this.idleTimeout }),
      ...(this.autoReconnect !== undefined && {
        autoReconnect: this.autoReconnect,
      }),
      ...(this.maxRetries !== undefined && { maxRetries: this.maxRetries }),
      ...(this.enableOfflineQueue !== undefined && {
        enableOfflineQueue: this.enableOfflineQueue,
      }),
      ...(this.enableAutoPipelining !== undefined && {
        enableAutoPipelining: this.enableAutoPipelining,
      }),
      ...(this.tls !== undefined && { tls: this.tls }),
    };
  }
}
