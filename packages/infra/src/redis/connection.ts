import { RedisError, RedisErrorCode } from './errors.js';

/**
 * What `Bun.RedisClient` accepts wherever a key or a raw value is expected.
 *
 * Aliased from Bun rather than restated: inside `declare module "bun"`,
 * `ArrayBufferView` is Bun's own union of concrete views, not the global
 * interface, so `string | ArrayBufferView | Blob` written here would be wider than
 * what the client actually takes.
 */
export type RedisKey = Bun.RedisClient.KeyLike;

/** A value to store. Numbers are stringified, as Redis stores only bytes. */
export type RedisValue = RedisKey | number;

/** Arguments for the raw `send()` escape hatch. */
export type RedisArg = string | number;

export interface SetOptions {
  /** Expire after N seconds. */
  readonly ex?: number;
  /** Expire after N milliseconds. */
  readonly px?: number;
  /** Expire at a unix timestamp in seconds. */
  readonly exat?: number;
  /** Expire at a unix timestamp in milliseconds. */
  readonly pxat?: number;
  /** Keep the existing TTL. */
  readonly keepttl?: boolean;
  /** Only set if the key does not exist. Resolves `null` when it did. */
  readonly nx?: boolean;
  /** Only set if the key already exists. Resolves `null` when it did not. */
  readonly xx?: boolean;
  /** Resolve the previous value instead of `'OK'`. */
  readonly get?: boolean;
}

export interface ScanOptions {
  readonly match?: string;
  readonly count?: number;
  readonly type?: string;
}

/** `[nextCursor, keys]`. A cursor of `'0'` means the iteration is complete. */
export type ScanResult = readonly [cursor: string, keys: readonly string[]];

export type MessageListener = (message: string, channel: string) => void;

/**
 * The injectable contract.
 *
 * An `abstract class` rather than an interface on purpose: `@dunx/transform` records
 * constructor parameter *types*, and an interface has no runtime value to record,
 * so an interface here would be a boot error at the injection site. See
 * CLAUDE.md, "Dependency injection".
 *
 * The surface is a curated subset of `Bun.RedisClient`'s ~250 methods - the ones
 * an application reaches for. Anything missing is one `send()` away, which is why
 * there is no attempt at completeness.
 */
export abstract class RedisConnection {
  /**
   * `abstract` stops TypeScript constructing this, but the container works on
   * runtime values, where every class self-binds - so `get(RedisConnection)` with
   * nothing bound would otherwise hand back a bare instance whose every method is
   * `undefined`. `new.target` is the subclass when a real implementation calls
   * `super()`, and this class itself only in the case worth rejecting.
   */
  constructor() {
    if (new.target === RedisConnection) {
      throw new RedisError(
        RedisErrorCode.INVALID_STATE,
        'RedisConnection is a contract, not an implementation. Bind one with ' +
          'RedisModule.forRoot(), and for a named connection ask for ' +
          'redisConnection(name) instead of RedisConnection.',
      );
    }
  }

  /** Whether the underlying socket is up. Commands connect lazily regardless. */
  abstract readonly connected: boolean;

  abstract ping(message?: string): Promise<string>;

  abstract get(key: RedisKey): Promise<string | null>;
  abstract getBuffer(key: RedisKey): Promise<Uint8Array<ArrayBuffer> | null>;
  /** Resolves `null` when `nx`/`xx` rejected the write, or the old value with `get`. */
  abstract set(
    key: RedisKey,
    value: RedisValue,
    options?: SetOptions,
  ): Promise<string | null>;
  abstract getdel(key: RedisKey): Promise<string | null>;
  abstract append(key: RedisKey, value: RedisValue): Promise<number>;
  abstract strlen(key: RedisKey): Promise<number>;

  /** The number of keys removed. */
  abstract del(key: RedisKey, ...rest: readonly RedisKey[]): Promise<number>;
  /**
   * Whether the key exists.
   *
   * Single-key only by design: Bun coerces Redis's integer reply to a boolean, so
   * a multi-key call cannot distinguish "one of three" from "three of three". Use
   * `send('EXISTS', keys)` for a count.
   */
  abstract exists(key: RedisKey): Promise<boolean>;
  abstract type(key: RedisKey): Promise<string>;
  abstract keys(pattern: string): Promise<readonly string[]>;
  abstract scan(
    cursor: string | number,
    options?: ScanOptions,
  ): Promise<ScanResult>;
  abstract rename(key: RedisKey, newKey: RedisKey): Promise<string>;

  abstract incr(key: RedisKey): Promise<number>;
  abstract incrby(key: RedisKey, by: number): Promise<number>;
  abstract decr(key: RedisKey): Promise<number>;
  abstract decrby(key: RedisKey, by: number): Promise<number>;

  /** `false` when the key does not exist. */
  abstract expire(key: RedisKey, seconds: number): Promise<boolean>;
  /** `false` when the key does not exist. */
  abstract pexpire(key: RedisKey, milliseconds: number): Promise<boolean>;
  /** Seconds remaining; `-1` with no TTL, `-2` when the key is gone. */
  abstract ttl(key: RedisKey): Promise<number>;
  /** Milliseconds remaining; `-1` with no TTL, `-2` when the key is gone. */
  abstract pttl(key: RedisKey): Promise<number>;
  /** `false` when the key does not exist or had no TTL. */
  abstract persist(key: RedisKey): Promise<boolean>;

  /** One entry per key, `null` for each miss, in the order asked. */
  abstract mget(
    key: RedisKey,
    ...rest: readonly RedisKey[]
  ): Promise<readonly (string | null)[]>;
  abstract mset(entries: Record<string, RedisValue>): Promise<string>;

  abstract hget(key: RedisKey, field: string): Promise<string | null>;
  /** The number of fields that were added rather than updated. */
  abstract hset(
    key: RedisKey,
    fields: Record<string, RedisValue>,
  ): Promise<number>;
  abstract hmget(
    key: RedisKey,
    field: string,
    ...rest: readonly string[]
  ): Promise<readonly (string | null)[]>;
  abstract hgetall(key: RedisKey): Promise<Record<string, string>>;
  abstract hdel(
    key: RedisKey,
    field: string,
    ...rest: readonly string[]
  ): Promise<number>;
  abstract hexists(key: RedisKey, field: string): Promise<boolean>;
  abstract hkeys(key: RedisKey): Promise<readonly string[]>;
  abstract hvals(key: RedisKey): Promise<readonly string[]>;
  abstract hlen(key: RedisKey): Promise<number>;
  abstract hincrby(key: RedisKey, field: string, by: number): Promise<number>;

  /** The list length after pushing. */
  abstract lpush(
    key: RedisKey,
    value: RedisValue,
    ...rest: readonly RedisValue[]
  ): Promise<number>;
  abstract rpush(
    key: RedisKey,
    value: RedisValue,
    ...rest: readonly RedisValue[]
  ): Promise<number>;
  abstract lpop(key: RedisKey): Promise<string | null>;
  abstract rpop(key: RedisKey): Promise<string | null>;
  abstract lrange(
    key: RedisKey,
    start: number,
    stop: number,
  ): Promise<readonly string[]>;
  abstract llen(key: RedisKey): Promise<number>;
  abstract lindex(key: RedisKey, index: number): Promise<string | null>;
  abstract lrem(
    key: RedisKey,
    count: number,
    value: RedisValue,
  ): Promise<number>;
  abstract ltrim(key: RedisKey, start: number, stop: number): Promise<string>;

  abstract sadd(
    key: RedisKey,
    member: string,
    ...rest: readonly string[]
  ): Promise<number>;
  abstract srem(
    key: RedisKey,
    member: string,
    ...rest: readonly string[]
  ): Promise<number>;
  abstract smembers(key: RedisKey): Promise<readonly string[]>;
  abstract sismember(key: RedisKey, member: string): Promise<boolean>;
  abstract scard(key: RedisKey): Promise<number>;

  /** The number of subscribers that received the message. */
  abstract publish(channel: string, message: string): Promise<number>;
  /**
   * Registers `listener` for `channel`.
   *
   * Runs on a second, lazily opened connection, because a `Bun.RedisClient` in
   * subscriber mode throws `ERR_REDIS_INVALID_STATE` for every data command. That
   * keeps `get`/`set` working on this same object while a subscription is live.
   */
  abstract subscribe(channel: string, listener: MessageListener): Promise<void>;
  /** Drops one listener, or every listener on the channel when omitted. */
  abstract unsubscribe(
    channel: string,
    listener?: MessageListener,
  ): Promise<void>;

  /**
   * Any command, including ones with no wrapper above.
   *
   * `unknown` rather than `any` (which is what Bun types it as) so the caller has
   * to narrow the reply.
   */
  abstract send(command: string, args?: readonly RedisArg[]): Promise<unknown>;
}
