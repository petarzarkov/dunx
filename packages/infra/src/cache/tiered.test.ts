import { AppError } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { FakeRedis } from './fake-redis.fixture.js';
import { MemoryCacheStore } from './memory.js';
import { RedisCacheStore } from './redis.js';
import { TieredCacheStore } from './tiered.js';

const tiers = (
  promoteTtl?: number,
): {
  l1: MemoryCacheStore;
  l2: RedisCacheStore;
  redis: FakeRedis;
  store: TieredCacheStore;
} => {
  const l1 = new MemoryCacheStore();
  const redis = new FakeRedis();
  const l2 = new RedisCacheStore(redis);
  return {
    l1,
    l2,
    redis,
    store: new TieredCacheStore(
      l1,
      l2,
      promoteTtl === undefined ? {} : { promoteTtl },
    ),
  };
};

describe('TieredCacheStore', () => {
  it('writes through to both tiers', async () => {
    const { l1, redis, store } = tiers();
    await store.set('k', { n: 1 }, 5_000);

    expect(await l1.get<{ n: number }>('k')).toEqual({ n: 1 });
    expect(redis.entries.has('k')).toBe(true);
  });

  it('caps the L1 lifetime at promoteTtl', async () => {
    const { l1, redis, store } = tiers(50);
    await store.set('k', 1, 5_000);
    expect(redis.writes[0]?.px).toBe(5_000);

    await Bun.sleep(80);
    // Gone from L1, still in L2, so the read promotes it back.
    expect(await l1.get('k')).toBeUndefined();
    expect(await store.get<number>('k')).toBe(1);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1])(
    'rejects a promoteTtl of %p rather than promoting forever',
    (promoteTtl) => {
      expect(() => tiers(promoteTtl)).toThrow(AppError);
    },
  );

  it('answers from L1 without reaching L2', async () => {
    const { l1, redis, store } = tiers();
    await l1.set('k', 'near', 5_000);
    await store.set('other', 1, 5_000);
    const before = redis.entries.size;

    expect(await store.get<string>('k')).toBe('near');
    expect(redis.entries.size).toBe(before);
  });

  it('promotes an L2 hit into L1', async () => {
    const { l1, l2, store } = tiers();
    await l2.set('k', 'far', 5_000);

    expect(await store.get<string>('k')).toBe('far');
    expect(await l1.get<string>('k')).toBe('far');
  });

  it('misses when neither tier holds the key', async () => {
    const { store } = tiers();
    expect(await store.get('k')).toBeUndefined();
  });

  it('deletes from both, and reports a hit in either', async () => {
    const { l1, l2, redis, store } = tiers();
    await store.set('k', 1, 5_000);

    expect(await store.del('k')).toBe(true);
    expect(await l1.get('k')).toBeUndefined();
    expect(redis.entries.has('k')).toBe(false);
    expect(await store.del('k')).toBe(false);

    // Only L2 holds it, which is the other node's situation after its own write.
    await l2.set('k', 2, 5_000);
    expect(await store.del('k')).toBe(true);
  });
});

/** An L2 whose read is slow enough for a write to land while it is in flight. */
class SlowL2 extends MemoryCacheStore {
  override async get<V>(key: string): Promise<V | undefined> {
    const value = await super.get<V>(key);
    await Bun.sleep(20);
    return value;
  }
}

describe('a write landing during a promote', () => {
  const racing = async (
    invalidate: (t: TieredCacheStore) => Promise<unknown>,
  ) => {
    const l1 = new MemoryCacheStore();
    const tiered = new TieredCacheStore(l1, new SlowL2(), {
      promoteTtl: 60_000,
    });
    await tiered.set('k', 'old', 60_000);
    await l1.del('k'); // the next read has to go to L2

    const reading = tiered.get('k');
    await Bun.sleep(5);
    await invalidate(tiered);
    await reading;
    return { l1, tiered };
  };

  it('does not put a deleted value back into L1', async () => {
    const { l1, tiered } = await racing((t) => t.del('k'));

    // The promote wrote `old` back for the whole promoteTtl, so a delete was
    // undone for thirty seconds by default.
    expect(await tiered.get('k')).toBeUndefined();
    expect(await l1.get('k')).toBeUndefined();
  });

  it('protects every concurrent read, not just the first to finish', async () => {
    let nth = 0;
    class Staggered extends MemoryCacheStore {
      override async get<V>(key: string): Promise<V | undefined> {
        const value = await super.get<V>(key);
        await Bun.sleep(++nth === 1 ? 10 : 40);
        return value;
      }
    }
    const l1 = new MemoryCacheStore();
    const tiered = new TieredCacheStore(l1, new Staggered(), {
      promoteTtl: 60_000,
    });
    await tiered.set('k', 'old', 60_000);
    await l1.del('k');

    const first = tiered.get('k');
    const second = tiered.get('k');
    await Bun.sleep(2);
    await tiered.del('k');
    await Promise.all([first, second]);

    // Marking the key rather than counting the readers let whichever finished
    // first clear it, and the one behind wrote the deleted value back.
    expect(await l1.get('k')).toBeUndefined();
  });

  it('does not overwrite a value written while it was reading', async () => {
    const { tiered } = await racing((t) => t.set('k', 'new', 60_000));

    expect(await tiered.get<string>('k')).toBe('new');
  });
});
