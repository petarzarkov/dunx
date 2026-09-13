import { describe, expect, it } from 'bun:test';
import { Cache } from './cache.js';
import { DegradingCacheStore } from './degrading.js';
import { MemoryCacheStore } from './memory.js';
import { CacheOptions } from './options.js';
import { CacheStore } from './store.js';
import { TieredCacheStore } from './tiered.js';
import { Quiet } from '../quiet.fixture.js';

/** What Bun's Redis client throws once it gives up reconnecting. `isConnectionError`
 * reads the `code` off any object, so this is the shape that matters. */
const connectionLost = (): Error =>
  Object.assign(new Error('Connection has failed'), {
    code: 'ERR_REDIS_CONNECTION_CLOSED',
  });

/** A store that is unreachable until `up` is set, and counts what reached it. */
class FlakyStore extends CacheStore {
  up = false;
  reads = 0;
  readonly entries = new Map<string, unknown>();

  async get<V>(key: string): Promise<V | undefined> {
    this.reads += 1;
    if (!this.up) throw connectionLost();
    return this.entries.get(key) as V | undefined;
  }

  async set<V>(key: string, value: V): Promise<void> {
    if (!this.up) throw connectionLost();
    this.entries.set(key, value);
  }

  async del(key: string): Promise<boolean> {
    if (!this.up) throw connectionLost();
    return this.entries.delete(key);
  }
}

/** The app's own bug, not the network's. */
class BadValueStore extends CacheStore {
  async get(): Promise<undefined> {
    throw new TypeError('Converting circular structure to JSON');
  }
  async set(): Promise<void> {
    throw new TypeError('Converting circular structure to JSON');
  }
  async del(): Promise<boolean> {
    throw new TypeError('Converting circular structure to JSON');
  }
}

const degrading = (inner: CacheStore, logger = new Quiet()) =>
  ({ store: new DegradingCacheStore(inner, { logger }), logger }) as const;

describe('an unreachable backend', () => {
  it('answers a read as a miss rather than throwing', async () => {
    const { store } = degrading(new FlakyStore());

    expect(await store.get('k')).toBeUndefined();
  });

  it('drops a write and reports a delete as nothing removed', async () => {
    const { store } = degrading(new FlakyStore());

    expect(await store.set('k', 'v', 1000)).toBeUndefined();
    expect(await store.del('k')).toBe(false);
  });

  it('warns once per outage, not once per operation', async () => {
    const inner = new FlakyStore();
    const { store, logger } = degrading(inner);

    for (let i = 0; i < 20; i += 1) await store.get(`k${String(i)}`);

    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]).toContain('unreachable');
    // Every call still went down to the store: this hides the failure, it does
    // not stop trying.
    expect(inner.reads).toBe(20);
  });

  it('says so again when the next outage starts', async () => {
    const inner = new FlakyStore();
    const { store, logger } = degrading(inner);

    await store.get('k');
    inner.up = true;
    await store.get('k');
    inner.up = false;
    await store.get('k');

    expect(logger.warnings).toHaveLength(2);
  });

  it('reports itself degraded, and not once it is answering', async () => {
    const inner = new FlakyStore();
    const { store } = degrading(inner);

    await store.get('k');
    expect(store.degraded).toBe(true);

    inner.up = true;
    await store.get('k');
    expect(store.degraded).toBe(false);
  });
});

describe('a failure that is the app’s own', () => {
  it('still throws, so a serialisation bug is not swallowed', async () => {
    const { store } = degrading(new BadValueStore());

    expect(store.get('k')).rejects.toThrow('circular structure');
    expect(store.set('k', 'v', 1)).rejects.toThrow('circular structure');
    expect(store.del('k')).rejects.toThrow('circular structure');
  });

  it('leaves the store reporting healthy, because nothing was wrong with it', async () => {
    const { store, logger } = degrading(new BadValueStore());

    await store.get('k').catch(() => undefined);

    expect(store.degraded).toBe(false);
    expect(logger.warnings).toHaveLength(0);
  });
});

/**
 * A last-seen flag starts optimistic: a fresh process reports the cache healthy
 * because nothing has touched it yet. `probe()` does one real read instead.
 */
describe('probe', () => {
  it('answers false on a store nothing has used yet', async () => {
    const { store } = degrading(new FlakyStore());

    expect(store.degraded).toBe(false);
    expect(await store.probe()).toBe(false);
    expect(store.degraded).toBe(true);
  });

  it('answers true for a reachable backend, a miss included', async () => {
    const inner = new FlakyStore();
    inner.up = true;
    const { store } = degrading(inner);

    expect(await store.probe()).toBe(true);
  });

  it('throws rather than lying when the failure is not a connection', async () => {
    const { store } = degrading(new BadValueStore());

    expect(store.probe()).rejects.toThrow('circular structure');
  });
});

describe('composition', () => {
  /** `Cache.wrap` needs no change: a degraded read is a miss, so it loads. */
  it('lets wrap fall through to the loader and still coalesce', async () => {
    const { store } = degrading(new FlakyStore());
    const cache = new Cache(new CacheOptions({ store }));
    let loads = 0;
    const load = async (): Promise<string> => {
      loads += 1;
      await Bun.sleep(5);
      return 'computed';
    };

    const all = await Promise.all([
      cache.wrap('k', load),
      cache.wrap('k', load),
      cache.wrap('k', load),
    ]);

    expect(all).toEqual(['computed', 'computed', 'computed']);
    expect(loads).toBe(1);
  });

  /** Wrapping L2 keeps L1 authoritative while Redis is gone. */
  it('keeps a tier serving from L1 when L2 is unreachable', async () => {
    const l1 = new MemoryCacheStore();
    const { store: l2 } = degrading(new FlakyStore());
    const tier = new TieredCacheStore(l1, l2);

    await tier.set('k', 'v', 10_000);

    expect(await tier.get<string>('k')).toBe('v');
  });
});

describe('CacheModule settings', () => {
  it('wraps the configured store when degrade is on', () => {
    const options = new CacheOptions({}, undefined, {});

    expect(options.store).toBeInstanceOf(DegradingCacheStore);
  });

  it('leaves the store alone when it is not', () => {
    expect(new CacheOptions({}).store).toBeInstanceOf(MemoryCacheStore);
  });

  /**
   * Outside the meter, so a swallowed failure is still counted as an error and
   * the hit rate is not inflated by the outage it hid.
   */
  it('sits outside the metered store', async () => {
    const { CacheMetrics, MeteredCacheStore } = await import('./metrics.js');
    const options = new CacheOptions({}, new CacheMetrics(), {});

    const outer = options.store;

    expect(outer).toBeInstanceOf(DegradingCacheStore);
    expect((outer as DegradingCacheStore).inner).toBeInstanceOf(
      MeteredCacheStore,
    );
  });
});
