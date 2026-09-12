import { AppFactory } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { Cache } from './cache.js';
import { MemoryCacheStore } from './memory.js';
import {
  CacheMetrics,
  CacheOperation,
  CacheOutcome,
  MeteredCacheStore,
} from './metrics.js';
import { CacheModule } from './module.js';
import { CacheOptions } from './options.js';
import { CacheStore } from './store.js';
import { TieredCacheStore } from './tiered.js';

const byOperation = (
  metrics: CacheMetrics,
): Map<string, { count: number; errors: number }> =>
  new Map(
    metrics
      .snapshot()
      .operations.map((o) => [
        o.operation,
        { count: o.count, errors: o.errors },
      ]),
  );

/** Every method rejects, so the error paths are asserted without a broker. */
class BrokenStore extends CacheStore {
  get<V = unknown>(_key: string): Promise<V | undefined> {
    return Promise.reject(new Error('down'));
  }

  set<V>(_key: string, _value: V, _ttl: number): Promise<void> {
    return Promise.reject(new Error('down'));
  }

  del(_key: string): Promise<boolean> {
    return Promise.reject(new Error('down'));
  }
}

describe('CacheMetrics', () => {
  it('separates hits from misses and reports the rate over reads alone', () => {
    const metrics = new CacheMetrics();
    metrics.observe(CacheOperation.GET, 1000, CacheOutcome.HIT);
    metrics.observe(CacheOperation.GET, 1000, CacheOutcome.HIT);
    metrics.observe(CacheOperation.GET, 1000, CacheOutcome.HIT);
    metrics.observe(CacheOperation.GET, 1000, CacheOutcome.MISS);
    metrics.observe(CacheOperation.SET, 1000);

    const report = metrics.snapshot();
    expect(report.hits).toBe(3);
    expect(report.misses).toBe(1);
    expect(report.hitRate).toBe(0.75);
    expect(report.total).toBe(5);
  });

  it('leaves a failed read out of both terms of the rate', () => {
    const metrics = new CacheMetrics();
    metrics.observe(CacheOperation.GET, 1000, CacheOutcome.HIT);
    metrics.observe(CacheOperation.GET, 1000, CacheOutcome.ERROR);

    const report = metrics.snapshot();
    expect(report.errors).toBe(1);
    expect(report.hitRate).toBe(1);
    expect(byOperation(metrics).get(CacheOperation.GET)).toEqual({
      count: 2,
      errors: 1,
    });
  });

  it('reports a rate of 0 before anything has been read', () => {
    const metrics = new CacheMetrics();
    metrics.observe(CacheOperation.SET, 1000);

    const report = metrics.snapshot();
    expect(report.hitRate).toBe(0);
    expect(report.operations).toHaveLength(1);
    expect(report.operations[0]?.duration.count).toBe(1);
  });

  it('lists the operations in one order whatever order they arrived in', () => {
    const metrics = new CacheMetrics();
    metrics.observe(CacheOperation.DEL, 1000);
    metrics.observe(CacheOperation.SET, 1000);
    metrics.observe(CacheOperation.GET, 1000, CacheOutcome.MISS);

    expect(metrics.snapshot().operations.map((o) => o.operation)).toEqual([
      CacheOperation.GET,
      CacheOperation.SET,
      CacheOperation.DEL,
    ]);
  });

  it('drops every series and moves since forward on reset', async () => {
    const metrics = new CacheMetrics();
    const before = metrics.snapshot().since;
    metrics.observe(CacheOperation.GET, 1000, CacheOutcome.HIT);
    await Bun.sleep(2);
    metrics.reset();

    const report = metrics.snapshot();
    expect(report.operations).toEqual([]);
    expect(report.hits).toBe(0);
    expect(report.total).toBe(0);
    expect(report.since > before).toBe(true);
  });
});

describe('MeteredCacheStore', () => {
  it('records a hit, a miss, a write and a delete at the store seam', async () => {
    const metrics = new CacheMetrics();
    const store = new MeteredCacheStore(new MemoryCacheStore(), metrics);

    expect(await store.get('absent')).toBeUndefined();
    await store.set('k', 1, 1_000);
    expect(await store.get<number>('k')).toBe(1);
    expect(await store.del('k')).toBe(true);

    const report = metrics.snapshot();
    expect(report.hits).toBe(1);
    expect(report.misses).toBe(1);
    expect(byOperation(metrics).get(CacheOperation.SET)?.count).toBe(1);
    expect(byOperation(metrics).get(CacheOperation.DEL)?.count).toBe(1);
    expect(report.total).toBe(4);
  });

  it('counts an expired entry as a miss, since that is what it answers', async () => {
    const metrics = new CacheMetrics();
    const store = new MeteredCacheStore(new MemoryCacheStore(), metrics);

    await store.set('k', 1, 1);
    await Bun.sleep(5);
    expect(await store.get('k')).toBeUndefined();

    expect(metrics.snapshot().misses).toBe(1);
  });

  it('records the failure and rethrows, on all three', async () => {
    const metrics = new CacheMetrics();
    const store = new MeteredCacheStore(new BrokenStore(), metrics);

    await expect(store.get('k')).rejects.toThrow('down');
    await expect(store.set('k', 1, 1_000)).rejects.toThrow('down');
    await expect(store.del('k')).rejects.toThrow('down');

    const report = metrics.snapshot();
    expect(report.errors).toBe(3);
    expect(report.hits).toBe(0);
    expect(report.misses).toBe(0);
    expect(report.hitRate).toBe(0);
  });

  it('times every operation it records', async () => {
    const metrics = new CacheMetrics();
    const store = new MeteredCacheStore(new MemoryCacheStore(), metrics);
    await store.set('k', 1, 1_000);

    const [set] = metrics.snapshot().operations;
    expect(set?.duration.count).toBe(1);
    expect(set?.duration.max ?? 0).toBeGreaterThan(0);
  });

  /**
   * A tier below is invisible on purpose: an L2 hit promoted into L1 is one
   * `get` and one hit, and the promotion write is not a `set`.
   */
  it('counts the logical operation when it wraps a tiered store', async () => {
    const metrics = new CacheMetrics();
    const l1 = new MemoryCacheStore();
    const l2 = new MemoryCacheStore();
    await l2.set('k', 1, 10_000);
    const store = new MeteredCacheStore(new TieredCacheStore(l1, l2), metrics);

    expect(await store.get<number>('k')).toBe(1);

    const report = metrics.snapshot();
    expect(report.hits).toBe(1);
    expect(report.total).toBe(1);
    expect(report.operations.map((o) => o.operation)).toEqual([
      CacheOperation.GET,
    ]);
  });
});

describe('CacheModule with metrics on', () => {
  it('binds CacheMetrics and meters the store behind Cache', async () => {
    const app = await AppFactory.create(
      CacheModule.forRoot({ ttl: 1_000 }, { metrics: true }),
    );
    const cache = app.get(Cache);

    expect(await cache.get('absent')).toBeUndefined();
    await cache.set('k', 'v');
    expect(await cache.get<string>('k')).toBe('v');

    const report = app.get(CacheMetrics).snapshot();
    expect(report.hits).toBe(1);
    expect(report.misses).toBe(1);
    expect(report.hitRate).toBe(0.5);
    expect(app.get(CacheStore)).toBeInstanceOf(MeteredCacheStore);
    await app.shutdown();
  });

  /**
   * `wrap` coalesces concurrent callers into one load, and the seam is the store,
   * so the miss and the write behind them are recorded once rather than five
   * times.
   */
  it('records the read wrap actually made, not one per caller', async () => {
    const app = await AppFactory.create(
      CacheModule.forRoot({}, { metrics: true }),
    );
    const cache = app.get(Cache);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        cache.wrap('k', async () => {
          await Bun.sleep(1);
          return 7;
        }),
      ),
    );

    const report = app.get(CacheMetrics).snapshot();
    expect(report.misses).toBe(1);
    expect(report.hits).toBe(0);
    expect(
      byOperation(app.get(CacheMetrics)).get(CacheOperation.SET)?.count,
    ).toBe(1);
    await app.shutdown();
  });

  /**
   * `app.get(CacheMetrics)` still answers without the flag: an unbound class
   * self-binds. What the flag decides is whether anything reports into it, so
   * that is what is asserted.
   */
  it('wraps no store when the flag is absent', async () => {
    const app = await AppFactory.create(CacheModule.forRoot({ ttl: 1_000 }));
    await app.get(Cache).set('k', 1);

    expect(app.get(CacheStore)).toBeInstanceOf(MemoryCacheStore);
    expect(app.get(CacheMetrics).snapshot().total).toBe(0);
    await app.shutdown();
  });

  it('meters the store a forRootAsync factory produced', async () => {
    const store = new MemoryCacheStore();
    const app = await AppFactory.create(
      CacheModule.forRootAsync(
        {
          useFactory: async () => {
            await Bun.sleep(1);
            return { store };
          },
        },
        { metrics: true },
      ),
    );

    await app.get(Cache).set('k', 1);

    expect(app.get(CacheOptions).store).toBeInstanceOf(MeteredCacheStore);
    expect(app.get(CacheMetrics).snapshot().total).toBe(1);
    await app.shutdown();
  });
});
