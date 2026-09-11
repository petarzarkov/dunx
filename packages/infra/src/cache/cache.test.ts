import { AppError } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { Cache } from './cache.js';
import { MemoryCacheStore } from './memory.js';
import { CacheOptions } from './options.js';

const cacheWith = (init: ConstructorParameters<typeof CacheOptions>[0] = {}) =>
  new Cache(new CacheOptions(init));

describe('CacheOptions', () => {
  it('defaults to a memory store and a minute', () => {
    const options = new CacheOptions();
    expect(options.store).toBeInstanceOf(MemoryCacheStore);
    expect(options.ttl).toBe(60_000);
    expect(options.keyFor('k')).toBe('k');
  });

  it('prefixes every key when asked', () => {
    expect(new CacheOptions({ prefix: 'app' }).keyFor('k')).toBe('app:k');
  });

  it.each([0, -1, Number.NaN])('rejects a ttl of %p', (ttl) => {
    expect(() => new CacheOptions({ ttl })).toThrow(AppError);
  });
});

describe('Cache', () => {
  it('gets, sets and deletes through the prefix', async () => {
    const store = new MemoryCacheStore();
    const cache = new Cache(new CacheOptions({ store, prefix: 'app' }));

    await cache.set('k', { n: 1 });
    expect(await store.get<{ n: number }>('app:k')).toEqual({ n: 1 });
    expect(await cache.get<{ n: number }>('k')).toEqual({ n: 1 });
    expect(await cache.del('k')).toBe(true);
    expect(await cache.get('k')).toBeUndefined();
  });

  it('takes a per-call ttl over the default', async () => {
    const cache = cacheWith({ ttl: 5_000 });
    await cache.set('brief', 1, 20);
    await Bun.sleep(50);
    expect(await cache.get('brief')).toBeUndefined();
  });

  it('wraps a load and serves the second call from the store', async () => {
    const cache = cacheWith();
    let loads = 0;
    const load = (): number => {
      loads += 1;
      return 41 + loads;
    };

    expect(await cache.wrap('k', load)).toBe(42);
    expect(await cache.wrap('k', load)).toBe(42);
    expect(loads).toBe(1);
  });

  it('runs one load for concurrent callers of one key', async () => {
    const cache = cacheWith();
    let loads = 0;
    const load = async (): Promise<number> => {
      loads += 1;
      await Bun.sleep(20);
      return loads;
    };

    const all = await Promise.all([
      cache.wrap('k', load),
      cache.wrap('k', load),
      cache.wrap('k', load),
    ]);

    expect(all).toEqual([1, 1, 1]);
    expect(loads).toBe(1);
  });

  it('keeps separate keys on separate loads', async () => {
    const cache = cacheWith();
    const [a, b] = await Promise.all([
      cache.wrap('a', () => 'a'),
      cache.wrap('b', () => 'b'),
    ]);
    expect([a, b]).toEqual(['a', 'b']);
  });

  it('does not cache a rejection, and retries the next call', async () => {
    const cache = cacheWith();
    let attempts = 0;
    const load = (): Promise<number> => {
      attempts += 1;
      return attempts === 1
        ? Promise.reject(new Error('upstream down'))
        : Promise.resolve(7);
    };

    await expect(cache.wrap('k', load)).rejects.toThrow('upstream down');
    expect(await cache.wrap('k', load)).toBe(7);
    expect(attempts).toBe(2);
  });

  it('rejects every concurrent caller when the load fails', async () => {
    const cache = cacheWith();
    const load = async (): Promise<number> => {
      await Bun.sleep(10);
      throw new Error('upstream down');
    };

    const settled = await Promise.allSettled([
      cache.wrap('k', load),
      cache.wrap('k', load),
    ]);

    expect(settled.map((one) => one.status)).toEqual(['rejected', 'rejected']);
  });

  it('does not store an undefined load', async () => {
    const cache = cacheWith();
    let loads = 0;
    const load = (): undefined => {
      loads += 1;
      return undefined;
    };

    expect(await cache.wrap('k', load)).toBeUndefined();
    expect(await cache.wrap('k', load)).toBeUndefined();
    expect(loads).toBe(2);
  });
});
