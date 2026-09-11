import { AppFactory, Module, provide, token } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { Cache } from './cache.js';
import { FakeRedis } from './fake-redis.fixture.js';
import { MemoryCacheStore } from './memory.js';
import { CacheModule } from './module.js';
import { CacheOptions } from './options.js';
import { RedisCacheStore } from './redis.js';
import { CacheStore } from './store.js';

/**
 * `bun test` runs from source with no `@dunx/transform` preload, so the record
 * the plugin would have appended is written by hand.
 */
class Prices {
  constructor(private readonly cache: Cache) {}

  quote(symbol: string, load: () => number): Promise<number> {
    return this.cache.wrap(symbol, load);
  }
}
Object.defineProperty(Prices, Symbol.for('dunx.deps'), {
  value: () => [Cache],
});

describe('CacheModule.forRoot', () => {
  it('binds the options, the store and the service', async () => {
    const app = await AppFactory.create(CacheModule.forRoot({ ttl: 1_000 }));

    expect(app.get(CacheOptions).ttl).toBe(1_000);
    expect(app.get(CacheStore)).toBeInstanceOf(MemoryCacheStore);
    expect(app.get(Cache)).toBeInstanceOf(Cache);
    await app.shutdown();
  });

  it('binds the store it was handed rather than a second one', async () => {
    const store = new RedisCacheStore(new FakeRedis());
    const app = await AppFactory.create(CacheModule.forRoot({ store }));

    expect(app.get(CacheStore)).toBe(store);
    await app.shutdown();
  });

  it('injects Cache into a consumer through its constructor', async () => {
    @Module({ imports: [CacheModule.forRoot()], providers: [Prices] })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    const prices = app.get(Prices);

    expect(await prices.quote('acme', () => 12)).toBe(12);
    expect(await prices.quote('acme', () => 99)).toBe(12);
    await app.shutdown();
  });
});

describe('CacheModule.forRootAsync', () => {
  it('builds the options from a factory', async () => {
    const app = await AppFactory.create(
      CacheModule.forRootAsync({
        useFactory: async () => {
          await Bun.sleep(1);
          return { ttl: 2_000, prefix: 'app' };
        },
      }),
    );

    expect(app.get(CacheOptions).ttl).toBe(2_000);
    expect(app.get(Cache)).toBeInstanceOf(Cache);
    await app.shutdown();
  });

  /**
   * A `token()`, never a class: an unbound class self-binds into whichever scope
   * asks first, so it would resolve whether or not `imports` reached the factory.
   */
  it('resolves the factory from its own imports', async () => {
    const BACKEND = token<RedisCacheStore>('Backend');

    @Module({
      providers: [
        provide(BACKEND, { useValue: new RedisCacheStore(new FakeRedis()) }),
      ],
      exports: [BACKEND],
    })
    class BackendModule {}

    const app = await AppFactory.create(
      CacheModule.forRootAsync({
        imports: [BackendModule],
        useFactory: (store: RedisCacheStore) => ({ store }),
        inject: [BACKEND] as const,
      }),
    );

    expect(app.get(CacheStore)).toBeInstanceOf(RedisCacheStore);
    await app.shutdown();
  });
});
