import { AppFactory, type App } from '@dunx/core';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { RedisConnection } from './connection.js';
import { RedisError, RedisErrorCode } from './errors.js';
import { RedisModule } from './module.js';
import { defaultRedisUrl } from './options.js';

const url = defaultRedisUrl();

/**
 * CI has no Redis, so the whole suite is conditional. The probe uses its own
 * short-lived client with retries off, otherwise an unreachable host would sit in
 * the offline queue for the default ten seconds.
 *
 * `connect()` is explicit because with the offline queue disabled there is nothing
 * to hold a lazily issued command during the handshake, and even a healthy server
 * would report itself unreachable.
 */
const reachable = async (): Promise<boolean> => {
  const client = new Bun.RedisClient(url, {
    connectionTimeout: 500,
    autoReconnect: false,
    enableOfflineQueue: false,
    maxRetries: 0,
  });
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    client.close();
  }
};

const live = await reachable();
if (!live) {
  console.log(`[dunx] redis integration tests skipped - ${url} unreachable`);
}

// A fresh namespace per run, so a leftover key can never make a test pass.
const ns = `dunx:test:${Bun.randomUUIDv7()}`;
const key = (name: string): string => `${ns}:${name}`;

describe.if(live)('Redis against a live server', () => {
  let app: App;
  let redis: RedisConnection;

  beforeAll(async () => {
    app = await AppFactory.create(RedisModule.forRoot({ url, eager: true }));
    redis = app.get(RedisConnection);
  });

  afterAll(async () => {
    const found = await redis.keys(`${ns}:*`);
    if (found.length > 0)
      await redis.del(found[0] as string, ...found.slice(1));
    await app.shutdown();
  });

  it('pings', async () => {
    expect(await redis.ping()).toBe('PONG');
    expect(await redis.ping('hello')).toBe('hello');
    expect(redis.connected).toBe(true);
  });

  it('round-trips a string', async () => {
    const k = key('str');
    expect(await redis.set(k, 'value')).toBe('OK');
    expect(await redis.get(k)).toBe('value');
    expect(await redis.exists(k)).toBe(true);
    expect(await redis.strlen(k)).toBe(5);
    expect(await redis.del(k)).toBe(1);
    expect(await redis.get(k)).toBeNull();
    expect(await redis.exists(k)).toBe(false);
  });

  it('stringifies a numeric value', async () => {
    const k = key('num');
    await redis.set(k, 42);
    expect(await redis.get(k)).toBe('42');
  });

  it('reads a value back as bytes', async () => {
    const k = key('buf');
    await redis.set(k, 'bytes');
    const buffer = await redis.getBuffer(k);
    expect(buffer).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(buffer ?? new Uint8Array())).toBe('bytes');
  });

  it('applies a TTL through set options', async () => {
    const k = key('ttl');
    await redis.set(k, 'v', { ex: 60 });
    const ttl = await redis.ttl(k);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60);
    expect(await redis.persist(k)).toBe(true);
    expect(await redis.ttl(k)).toBe(-1);
  });

  it('honours nx and xx', async () => {
    const k = key('nx');
    expect(await redis.set(k, 'first', { nx: true })).toBe('OK');
    expect(await redis.set(k, 'second', { nx: true })).toBeNull();
    expect(await redis.get(k)).toBe('first');
    expect(await redis.set(k, 'third', { xx: true })).toBe('OK');
    expect(await redis.set(key('absent'), 'x', { xx: true })).toBeNull();
  });

  it('returns the previous value with the get option', async () => {
    const k = key('getopt');
    await redis.set(k, 'old');
    expect(await redis.set(k, 'new', { get: true })).toBe('old');
    expect(await redis.get(k)).toBe('new');
  });

  it('expires in milliseconds and reports pttl', async () => {
    const k = key('pttl');
    await redis.set(k, 'v');
    expect(await redis.pexpire(k, 30_000)).toBe(true);
    expect(await redis.pttl(k)).toBeGreaterThan(0);
    expect(await redis.expire(key('absent'), 10)).toBe(false);
    expect(await redis.persist(key('absent'))).toBe(false);
  });

  it('reports -2 for the ttl of a missing key', async () => {
    expect(await redis.ttl(key('absent'))).toBe(-2);
  });

  it('takes and deletes in one step', async () => {
    const k = key('getdel');
    await redis.set(k, 'once');
    expect(await redis.getdel(k)).toBe('once');
    expect(await redis.get(k)).toBeNull();
  });

  it('counts up and down', async () => {
    const k = key('counter');
    expect(await redis.incr(k)).toBe(1);
    expect(await redis.incrby(k, 9)).toBe(10);
    expect(await redis.decr(k)).toBe(9);
    expect(await redis.decrby(k, 4)).toBe(5);
  });

  it('appends, renames and reports type', async () => {
    const k = key('append');
    await redis.set(k, 'ab');
    expect(await redis.append(k, 'cd')).toBe(4);
    expect(await redis.type(k)).toBe('string');
    const renamed = key('renamed');
    expect(await redis.rename(k, renamed)).toBe('OK');
    expect(await redis.get(renamed)).toBe('abcd');
  });

  it('sets and gets many at once', async () => {
    const a = key('m:a');
    const b = key('m:b');
    expect(await redis.mset({ [a]: 'A', [b]: 2 })).toBe('OK');
    expect(await redis.mget(a, b, key('m:missing'))).toEqual(['A', '2', null]);
  });

  it('handles hashes', async () => {
    const k = key('hash');
    expect(await redis.hset(k, { name: 'ada', hits: 1 })).toBe(2);
    expect(await redis.hget(k, 'name')).toBe('ada');
    expect(await redis.hgetall(k)).toEqual({ name: 'ada', hits: '1' });
    expect(await redis.hmget(k, 'name', 'nope')).toEqual(['ada', null]);
    expect(await redis.hexists(k, 'name')).toBe(true);
    expect(await redis.hincrby(k, 'hits', 4)).toBe(5);
    expect(await redis.hlen(k)).toBe(2);
    expect([...(await redis.hkeys(k))].sort()).toEqual(['hits', 'name']);
    expect([...(await redis.hvals(k))].sort()).toEqual(['5', 'ada']);
    expect(await redis.hdel(k, 'name')).toBe(1);
    expect(await redis.hexists(k, 'name')).toBe(false);
  });

  it('handles lists', async () => {
    const k = key('list');
    expect(await redis.rpush(k, 'b', 'c')).toBe(2);
    expect(await redis.lpush(k, 'a')).toBe(3);
    expect(await redis.lrange(k, 0, -1)).toEqual(['a', 'b', 'c']);
    expect(await redis.llen(k)).toBe(3);
    expect(await redis.lindex(k, 1)).toBe('b');
    expect(await redis.lpop(k)).toBe('a');
    expect(await redis.rpop(k)).toBe('c');
    await redis.rpush(k, 'b', 'b');
    expect(await redis.lrem(k, 2, 'b')).toBe(2);
    expect(await redis.ltrim(k, 0, -1)).toBe('OK');
  });

  it('handles sets', async () => {
    const k = key('set');
    expect(await redis.sadd(k, 'x', 'y')).toBe(2);
    expect(await redis.scard(k)).toBe(2);
    expect(await redis.sismember(k, 'x')).toBe(true);
    expect([...(await redis.smembers(k))].sort()).toEqual(['x', 'y']);
    expect(await redis.srem(k, 'x')).toBe(1);
    expect(await redis.sismember(k, 'x')).toBe(false);
  });

  it('scans with a match pattern', async () => {
    await redis.set(key('scan:1'), '1');
    await redis.set(key('scan:2'), '2');
    const found = new Set<string>();
    let cursor: string | number = 0;
    do {
      const [next, keys] = await redis.scan(cursor, {
        match: `${ns}:scan:*`,
        count: 100,
      });
      for (const found_ of keys) found.add(found_);
      cursor = next;
    } while (cursor !== '0');
    expect([...found].sort()).toEqual([key('scan:1'), key('scan:2')]);
  });

  it('runs a raw command through send', async () => {
    const k = key('raw');
    expect(await redis.send('SET', [k, 'v'])).toBe('OK');
    // EXISTS returns a count here, which is why the typed exists() is single-key.
    expect(await redis.send('EXISTS', [k, key('absent')])).toBe(1);
    expect(await redis.send('EXPIRE', [k, 30])).toBe(1);
  });

  describe('error mapping', () => {
    const failure = async (
      run: () => Promise<unknown>,
    ): Promise<RedisError> => {
      const error = await run().then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(RedisError);
      return error as RedisError;
    };

    it('reports an unknown command with the command name attached', async () => {
      const error = await failure(() => redis.send('NOPECMD'));
      expect(error.code).toBe(RedisErrorCode.INVALID_RESPONSE);
      expect(error.command).toBe('NOPECMD');
      expect(error.message).toContain('unknown command');
    });

    it('reports WRONGTYPE under INVALID_RESPONSE', async () => {
      const k = key('wrongtype');
      await redis.rpush(k, 'a');
      const error = await failure(() => redis.get(k));
      expect(error.code).toBe(RedisErrorCode.INVALID_RESPONSE);
      expect(error.command).toBe('GET');
      expect(error.message).toContain('WRONGTYPE');
    });
  });

  describe('pub/sub', () => {
    it('delivers a message and leaves data commands working', async () => {
      const received: [string, string][] = [];
      const channel = key('chan');
      await redis.subscribe(channel, (message, from) => {
        received.push([from, message]);
      });

      // The regression this design exists for: Bun throws
      // ERR_REDIS_INVALID_STATE for any data command on a client in subscriber
      // mode, so subscriptions run on a second connection.
      const k = key('while-subscribed');
      expect(await redis.set(k, 'still works')).toBe('OK');
      expect(await redis.get(k)).toBe('still works');

      expect(await redis.publish(channel, 'hello')).toBeGreaterThanOrEqual(1);
      await Bun.sleep(150);
      expect(received).toEqual([[channel, 'hello']]);

      await redis.unsubscribe(channel);
    });

    it('fans out to two listeners and can drop one', async () => {
      const channel = key('chan2');
      const first: string[] = [];
      const second: string[] = [];
      const onSecond = (message: string): void => {
        second.push(message);
      };

      await redis.subscribe(channel, (message) => {
        first.push(message);
      });
      await redis.subscribe(channel, onSecond);
      await redis.publish(channel, 'both');
      await Bun.sleep(150);
      expect(first).toEqual(['both']);
      expect(second).toEqual(['both']);

      await redis.unsubscribe(channel, onSecond);
      await redis.publish(channel, 'one');
      await Bun.sleep(150);
      expect(first).toEqual(['both', 'one']);
      expect(second).toEqual(['both']);

      await redis.unsubscribe(channel);
    });

    it('stops delivering after unsubscribing', async () => {
      const channel = key('chan3');
      const received: string[] = [];
      await redis.subscribe(channel, (message) => {
        received.push(message);
      });
      await redis.unsubscribe(channel);
      await redis.publish(channel, 'ignored');
      await Bun.sleep(150);
      expect(received).toEqual([]);
    });
  });
});

describe.if(live)('shutdown', () => {
  it('closes the connection and the subscriber connection', async () => {
    const app = await AppFactory.create(RedisModule.forRoot({ url }));
    const redis = app.get(RedisConnection);
    const channel = key('shutdown');
    const received: string[] = [];
    await redis.subscribe(channel, (message) => {
      received.push(message);
    });
    expect(await redis.ping()).toBe('PONG');

    await app.shutdown();
    expect(redis.connected).toBe(false);

    const error = await redis.ping().then(
      () => undefined,
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(RedisError);
    expect(received).toEqual([]);
  });

  /**
   * A subprocess, because `bun test` exits the runner itself and would therefore
   * never notice: measured on Bun 1.3.14, a `Bun.RedisClient` left in subscriber
   * mode keeps the event loop alive after `close()`, so a service that shut down
   * cleanly still hung forever. `onShutdown` leaves subscriber mode first, and
   * this is what proves it - without the `unsubscribe()` the spawn times out.
   */
  it('lets the process exit after a subscription was opened', async () => {
    const source = new URL('./', import.meta.url).pathname;
    const script =
      `const { Redis } = await import(${JSON.stringify(`${source}client.ts`)});\n` +
      `const { RedisOptions } = await import(${JSON.stringify(`${source}options.ts`)});\n` +
      `const redis = new Redis(new RedisOptions({ url: ${JSON.stringify(url)}, maxRetries: 0 }));\n` +
      `await redis.subscribe(${JSON.stringify(key('exit'))}, () => {});\n` +
      'await redis.onShutdown();\n' +
      "console.log('shut down');\n";

    const proc = Bun.spawn(['bun', '-e', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const timer = setTimeout(() => proc.kill(), 8000);
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    clearTimeout(timer);

    expect(out).toContain('shut down');
    expect(code).toBe(0);
  }, 15_000);
});
