import type { OnInit, OnShutdown } from '@dunx/core';
import {
  RedisConnection,
  type MessageListener,
  type RedisArg,
  type RedisKey,
  type RedisValue,
  type ScanOptions,
  type ScanResult,
  type SetOptions,
} from './connection.js';
import { toRedisError } from './errors.js';
import { RedisOptions } from './options.js';

const toKeyLike = (value: RedisValue): RedisKey =>
  typeof value === 'number' ? String(value) : value;

const setArgs = (options: SetOptions | undefined): string[] => {
  if (!options) return [];
  const args: string[] = [];
  if (options.ex !== undefined) args.push('EX', String(options.ex));
  if (options.px !== undefined) args.push('PX', String(options.px));
  if (options.exat !== undefined) args.push('EXAT', String(options.exat));
  if (options.pxat !== undefined) args.push('PXAT', String(options.pxat));
  if (options.keepttl) args.push('KEEPTTL');
  if (options.nx) args.push('NX');
  if (options.xx) args.push('XX');
  if (options.get) args.push('GET');
  return args;
};

const scanArgs = (options: ScanOptions | undefined): (string | number)[] => {
  if (!options) return [];
  const args: (string | number)[] = [];
  if (options.match !== undefined) args.push('MATCH', options.match);
  if (options.count !== undefined) args.push('COUNT', options.count);
  if (options.type !== undefined) args.push('TYPE', options.type);
  return args;
};

/**
 * `RedisConnection` on top of `Bun.RedisClient`.
 *
 * Not exported from the package root - bind it through `RedisModule.forRoot()`,
 * which is what decides how the connection is constructed.
 */
export class Redis extends RedisConnection implements OnInit, OnShutdown {
  readonly #client: Bun.RedisClient;
  readonly #options: RedisOptions;
  /**
   * A `Bun.RedisClient` in subscriber mode rejects every data command, so
   * subscriptions get their own socket. Opened on first `subscribe()` and never
   * before, so a connection nobody subscribes on costs nothing.
   */
  #subscriber: Bun.RedisClient | undefined;
  readonly #listeners = new Map<string, Set<MessageListener>>();

  constructor(options: RedisOptions) {
    super();
    this.#options = options;
    this.#client = new Bun.RedisClient(options.url, options.toClientOptions());
  }

  get connected(): boolean {
    return this.#client.connected;
  }

  /**
   * Only when `eager` is set: prove the server is reachable during boot.
   *
   * `connect()` before `ping()`, not just `ping()`. Commands normally connect
   * lazily, but with `enableOfflineQueue: false` there is no queue to hold the
   * first one while the handshake runs, so it is rejected outright - a failure
   * about the offline queue rather than about the server.
   */
  async onInit(): Promise<void> {
    if (!this.#options.eager) return;
    await this.#run('CONNECT', () => this.#client.connect());
    await this.ping();
  }

  /**
   * `UNSUBSCRIBE` before `close()`, and that order is load-bearing: measured on
   * Bun 1.3.14, a `Bun.RedisClient` left in subscriber mode keeps the event loop
   * alive after `close()`, so a process that shut down cleanly would still never
   * exit. Leaving subscriber mode first fixes it. Recorded in docs/bun-apis.md.
   */
  async onShutdown(): Promise<void> {
    const subscriber = this.#subscriber;
    this.#listeners.clear();
    this.#subscriber = undefined;
    if (subscriber) {
      try {
        await subscriber.unsubscribe();
      } catch {
        // A socket that is already gone is not in subscriber mode either, and
        // throwing here would leave both connections below unclosed.
      }
      subscriber.close();
    }
    this.#client.close();
  }

  /**
   * Every command goes through here. The call is inside the `try` rather than just
   * the await, because Bun throws synchronously for state errors (subscriber mode)
   * and argument errors - an `async` wrapper turns both into one rejection shape.
   */
  async #run<T>(command: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (cause) {
      throw toRedisError(command, cause);
    }
  }

  ping(message?: string): Promise<string> {
    return this.#run('PING', () =>
      message === undefined ? this.#client.ping() : this.#client.ping(message),
    );
  }

  get(key: RedisKey): Promise<string | null> {
    return this.#run('GET', () => this.#client.get(key));
  }

  getBuffer(key: RedisKey): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.#run('GET', () => this.#client.getBuffer(key));
  }

  set(
    key: RedisKey,
    value: RedisValue,
    options?: SetOptions,
  ): Promise<string | null> {
    return this.#run('SET', () =>
      this.#client.set(key, toKeyLike(value), ...setArgs(options)),
    );
  }

  getdel(key: RedisKey): Promise<string | null> {
    return this.#run('GETDEL', () => this.#client.getdel(key));
  }

  append(key: RedisKey, value: RedisValue): Promise<number> {
    return this.#run('APPEND', () =>
      this.#client.append(key, toKeyLike(value)),
    );
  }

  strlen(key: RedisKey): Promise<number> {
    return this.#run('STRLEN', () => this.#client.strlen(key));
  }

  del(key: RedisKey, ...rest: readonly RedisKey[]): Promise<number> {
    return this.#run('DEL', () => this.#client.del(key, ...rest));
  }

  exists(key: RedisKey): Promise<boolean> {
    return this.#run('EXISTS', () => this.#client.exists(key));
  }

  type(key: RedisKey): Promise<string> {
    return this.#run('TYPE', () => this.#client.type(key));
  }

  keys(pattern: string): Promise<readonly string[]> {
    return this.#run('KEYS', () => this.#client.keys(pattern));
  }

  scan(cursor: string | number, options?: ScanOptions): Promise<ScanResult> {
    return this.#run('SCAN', () =>
      this.#client.scan(cursor, ...scanArgs(options)),
    );
  }

  rename(key: RedisKey, newKey: RedisKey): Promise<string> {
    return this.#run('RENAME', () => this.#client.rename(key, newKey));
  }

  incr(key: RedisKey): Promise<number> {
    return this.#run('INCR', () => this.#client.incr(key));
  }

  incrby(key: RedisKey, by: number): Promise<number> {
    return this.#run('INCRBY', () => this.#client.incrby(key, by));
  }

  decr(key: RedisKey): Promise<number> {
    return this.#run('DECR', () => this.#client.decr(key));
  }

  decrby(key: RedisKey, by: number): Promise<number> {
    return this.#run('DECRBY', () => this.#client.decrby(key, by));
  }

  async expire(key: RedisKey, seconds: number): Promise<boolean> {
    return (
      (await this.#run('EXPIRE', () => this.#client.expire(key, seconds))) === 1
    );
  }

  async pexpire(key: RedisKey, milliseconds: number): Promise<boolean> {
    return (
      (await this.#run('PEXPIRE', () =>
        this.#client.pexpire(key, milliseconds),
      )) === 1
    );
  }

  ttl(key: RedisKey): Promise<number> {
    return this.#run('TTL', () => this.#client.ttl(key));
  }

  pttl(key: RedisKey): Promise<number> {
    return this.#run('PTTL', () => this.#client.pttl(key));
  }

  async persist(key: RedisKey): Promise<boolean> {
    return (await this.#run('PERSIST', () => this.#client.persist(key))) === 1;
  }

  mget(
    key: RedisKey,
    ...rest: readonly RedisKey[]
  ): Promise<readonly (string | null)[]> {
    return this.#run('MGET', () => this.#client.mget(key, ...rest));
  }

  mset(entries: Record<string, RedisValue>): Promise<string> {
    const flat = Object.entries(entries).flatMap(([field, value]) => [
      field,
      toKeyLike(value),
    ]);
    return this.#run('MSET', () => this.#client.mset(...flat));
  }

  hget(key: RedisKey, field: string): Promise<string | null> {
    return this.#run('HGET', () => this.#client.hget(key, field));
  }

  hset(key: RedisKey, fields: Record<string, RedisValue>): Promise<number> {
    return this.#run('HSET', () => this.#client.hset(key, fields));
  }

  hmget(
    key: RedisKey,
    field: string,
    ...rest: readonly string[]
  ): Promise<readonly (string | null)[]> {
    return this.#run('HMGET', () => this.#client.hmget(key, field, ...rest));
  }

  hgetall(key: RedisKey): Promise<Record<string, string>> {
    return this.#run('HGETALL', () => this.#client.hgetall(key));
  }

  hdel(
    key: RedisKey,
    field: string,
    ...rest: readonly string[]
  ): Promise<number> {
    return this.#run('HDEL', () => this.#client.hdel(key, field, ...rest));
  }

  hexists(key: RedisKey, field: string): Promise<boolean> {
    return this.#run('HEXISTS', () => this.#client.hexists(key, field));
  }

  hkeys(key: RedisKey): Promise<readonly string[]> {
    return this.#run('HKEYS', () => this.#client.hkeys(key));
  }

  hvals(key: RedisKey): Promise<readonly string[]> {
    return this.#run('HVALS', () => this.#client.hvals(key));
  }

  hlen(key: RedisKey): Promise<number> {
    return this.#run('HLEN', () => this.#client.hlen(key));
  }

  hincrby(key: RedisKey, field: string, by: number): Promise<number> {
    return this.#run('HINCRBY', () => this.#client.hincrby(key, field, by));
  }

  lpush(
    key: RedisKey,
    value: RedisValue,
    ...rest: readonly RedisValue[]
  ): Promise<number> {
    return this.#run('LPUSH', () =>
      this.#client.lpush(key, toKeyLike(value), ...rest.map(toKeyLike)),
    );
  }

  rpush(
    key: RedisKey,
    value: RedisValue,
    ...rest: readonly RedisValue[]
  ): Promise<number> {
    return this.#run('RPUSH', () =>
      this.#client.rpush(key, toKeyLike(value), ...rest.map(toKeyLike)),
    );
  }

  lpop(key: RedisKey): Promise<string | null> {
    return this.#run('LPOP', () => this.#client.lpop(key));
  }

  rpop(key: RedisKey): Promise<string | null> {
    return this.#run('RPOP', () => this.#client.rpop(key));
  }

  lrange(
    key: RedisKey,
    start: number,
    stop: number,
  ): Promise<readonly string[]> {
    return this.#run('LRANGE', () => this.#client.lrange(key, start, stop));
  }

  llen(key: RedisKey): Promise<number> {
    return this.#run('LLEN', () => this.#client.llen(key));
  }

  lindex(key: RedisKey, index: number): Promise<string | null> {
    return this.#run('LINDEX', () => this.#client.lindex(key, index));
  }

  lrem(key: RedisKey, count: number, value: RedisValue): Promise<number> {
    return this.#run('LREM', () =>
      this.#client.lrem(key, count, toKeyLike(value)),
    );
  }

  ltrim(key: RedisKey, start: number, stop: number): Promise<string> {
    return this.#run('LTRIM', () => this.#client.ltrim(key, start, stop));
  }

  sadd(
    key: RedisKey,
    member: string,
    ...rest: readonly string[]
  ): Promise<number> {
    return this.#run('SADD', () => this.#client.sadd(key, member, ...rest));
  }

  srem(
    key: RedisKey,
    member: string,
    ...rest: readonly string[]
  ): Promise<number> {
    return this.#run('SREM', () => this.#client.srem(key, member, ...rest));
  }

  smembers(key: RedisKey): Promise<readonly string[]> {
    return this.#run('SMEMBERS', () => this.#client.smembers(key));
  }

  sismember(key: RedisKey, member: string): Promise<boolean> {
    return this.#run('SISMEMBER', () => this.#client.sismember(key, member));
  }

  scard(key: RedisKey): Promise<number> {
    return this.#run('SCARD', () => this.#client.scard(key));
  }

  publish(channel: string, message: string): Promise<number> {
    return this.#run('PUBLISH', () => this.#client.publish(channel, message));
  }

  /**
   * `connect()` before the first `subscribe()`, and only on a socket this call
   * opened: measured on Bun 1.3.14, a `subscribe()` that cannot reach the server
   * leaves the client holding the event loop open even after `close()` and even
   * with `maxRetries: 0`, so the process never exits. Failing at `connect()`
   * instead releases cleanly. Recorded in docs/bun-apis.md.
   */
  async subscribe(channel: string, listener: MessageListener): Promise<void> {
    let client = this.#subscriber;
    if (!client) {
      client = new Bun.RedisClient(
        this.#options.url,
        this.#options.toClientOptions(),
      );
      try {
        await client.connect();
      } catch (cause) {
        client.close();
        throw toRedisError('CONNECT', cause);
      }
      this.#subscriber = client;
    }

    const existing = this.#listeners.get(channel);
    if (existing) {
      existing.add(listener);
    } else {
      this.#listeners.set(channel, new Set([listener]));
    }

    await this.#run('SUBSCRIBE', async () => {
      await client.subscribe(channel, listener);
    });
  }

  async unsubscribe(
    channel: string,
    listener?: MessageListener,
  ): Promise<void> {
    const client = this.#subscriber;
    const registered = this.#listeners.get(channel);
    // Nothing was ever subscribed here; Bun would throw ERR_REDIS_INVALID_STATE.
    if (!client || !registered) return;

    if (listener) {
      registered.delete(listener);
      await this.#run('UNSUBSCRIBE', async () => {
        await client.unsubscribe(channel, listener);
      });
      if (registered.size > 0) return;
    } else {
      await this.#run('UNSUBSCRIBE', async () => {
        await client.unsubscribe(channel);
      });
    }

    this.#listeners.delete(channel);
  }

  send(command: string, args: readonly RedisArg[] = []): Promise<unknown> {
    return this.#run(command.toUpperCase(), () =>
      this.#client.send(
        command,
        args.map((arg) => String(arg)),
      ),
    );
  }
}
