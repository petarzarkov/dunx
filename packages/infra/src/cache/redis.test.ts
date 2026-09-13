import { AppFactory, type App } from '@dunx/core';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { RedisConnection } from '../redis/connection.js';
import { redisReachable } from '../reachable.fixture.js';
import { RedisModule } from '../redis/module.js';
import { defaultRedisUrl } from '../redis/options.js';
import { FakeRedis } from './fake-redis.fixture.js';
import { RedisCacheStore } from './redis.js';

describe('RedisCacheStore', () => {
  it('round-trips a value as JSON', async () => {
    const redis = new FakeRedis();
    const store = new RedisCacheStore(redis);
    const value = { name: 'ada', tags: ['a', 'b'] };

    await store.set('k', value, 5_000);
    const read = await store.get<typeof value>('k');

    expect(read).toEqual(value);
    // JSON, so it is a copy rather than the object that went in.
    expect(read).not.toBe(value);
    expect(redis.writes[0]).toEqual({ key: 'k', px: 5_000 });
  });

  it('misses an absent key', async () => {
    expect(await new RedisCacheStore(new FakeRedis()).get('k')).toBeUndefined();
  });

  it('rounds a fractional ttl up to at least one millisecond', async () => {
    const redis = new FakeRedis();
    await new RedisCacheStore(redis).set('k', 1, 0.2);
    expect(redis.writes[0]?.px).toBe(1);
  });

  it('removes the key rather than writing an unserialisable value', async () => {
    const redis = new FakeRedis();
    const store = new RedisCacheStore(redis);

    await store.set('k', 1, 5_000);
    await store.set('k', undefined, 5_000);

    expect(redis.entries.has('k')).toBe(false);
    expect(redis.writes).toHaveLength(1);
  });

  it('reports whether del removed anything', async () => {
    const store = new RedisCacheStore(new FakeRedis());
    await store.set('k', 1, 5_000);
    expect(await store.del('k')).toBe(true);
    expect(await store.del('k')).toBe(false);
  });
});

const url = defaultRedisUrl();

const live = await redisReachable(url);
if (!live) {
  console.log(`[dunx] cache integration tests skipped - ${url} unreachable`);
}

const ns = `dunx:cache-test:${Bun.randomUUIDv7()}`;

describe.if(live)('RedisCacheStore against a live server', () => {
  let app: App;
  let store: RedisCacheStore;

  beforeAll(async () => {
    app = await AppFactory.create(RedisModule.forRoot({ url, eager: true }));
    // `RedisConnection` is never named by the store: it satisfies `CacheRedis`
    // structurally, which is what this line is asserting.
    store = new RedisCacheStore(app.get(RedisConnection));
  });

  afterAll(async () => {
    await store.del(`${ns}:value`);
    await app.shutdown();
  });

  it('writes, reads and expires a real key', async () => {
    await store.set(`${ns}:value`, { ok: true }, 5_000);
    expect(await store.get<{ ok: boolean }>(`${ns}:value`)).toEqual({
      ok: true,
    });

    await store.set(`${ns}:brief`, 1, 30);
    await Bun.sleep(80);
    expect(await store.get(`${ns}:brief`)).toBeUndefined();
  });
});
