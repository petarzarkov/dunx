# Caching

`Cache` reads and writes values with a lifetime. It comes from
`@dunx/infra/cache` and runs over a `Map` in this process, over Redis through a
connection the app already owns, or over both.

```ts
import { Module } from '@dunx/core';
import { Cache, CacheModule } from '@dunx/infra/cache';

export class Prices {
  constructor(private readonly cache: Cache) {}

  quote(symbol: string): Promise<Quote> {
    return this.cache.wrap(`quote:${symbol}`, () => this.fetchQuote(symbol));
  }
}

@Module({
  imports: [CacheModule.forRoot({ ttl: 30_000, prefix: 'prices' })],
  providers: [Prices],
})
export class AppModule {}
```

`CacheModule` binds three tokens: `CacheOptions`, `CacheStore` and `Cache`.

## The service

| Method                  | Answers                                           |
| ----------------------- | ------------------------------------------------- |
| `get<V>(key)`           | the value, or `undefined`                         |
| `set(key, value, ttl?)` | nothing; `ttl` falls back to the module's         |
| `del(key)`              | whether a live entry was removed                  |
| `wrap(key, load, ttl?)` | the cached value, or `load()` stored and returned |

Every lifetime is in milliseconds. `prefix` is prepended to every key with a `:`,
so two apps can share one Redis without reading each other's entries.

`undefined` is a miss, and a `load()` returning `undefined` is not stored: the
next `wrap` runs it again.

## Single flight

Concurrent `wrap` calls for one key run `load()` once. The second caller receives
the first one's promise, and a rejection is not cached: the next call loads again.

A `set` or `del` for the same key while `load()` is running wins. `wrap` hands the
loaded value to its caller and does not store it, so a `del` stays a `del`.

Dedupe is per process. Ten replicas handling a cold key run ten loads.

## The three stores

`CacheStore` is an abstract class with three implementations. Bind one through
`store`:

| Store              | Holds                                            |
| ------------------ | ------------------------------------------------ |
| `MemoryCacheStore` | a bounded `Map` in this process                  |
| `RedisCacheStore`  | JSON in Redis, `SET key value PX ttl`            |
| `TieredCacheStore` | `MemoryCacheStore` in front of `RedisCacheStore` |

```ts
import {
  CacheModule,
  MemoryCacheStore,
  RedisCacheStore,
  TieredCacheStore,
} from '@dunx/infra/cache';
import { RedisConnection, RedisModule } from '@dunx/infra/redis';

CacheModule.forRootAsync({
  imports: [RedisModule.forRoot()],
  useFactory: (redis: RedisConnection) => ({
    ttl: 60_000,
    store: new TieredCacheStore(
      new MemoryCacheStore({ max: 5_000 }),
      new RedisCacheStore(redis),
      { promoteTtl: 5_000 },
    ),
  }),
  inject: [RedisConnection],
});
```

`MemoryCacheStore` evicts the least recently used key past `max`, which defaults
to 10,000. 100k entries measure 16.1 MB, so `max` is what decides the footprint.

`RedisCacheStore` takes any object with `get`, `set` and `del` - `RedisConnection`
satisfies it, and so does a bare `Bun.RedisClient`. It opens no connection of its
own and closes none. Values travel as JSON, so a `Date` comes back as a string and
a `Map` comes back as `{}`. `MemoryCacheStore` stores the value by reference, so a
reader that mutates what it got back changes what the next reader gets.

`TieredCacheStore` answers from L1 when it can, copies an L2 hit into L1 for
`promoteTtl`, and writes and deletes through to both.

## What two nodes see

L1 is local and L2 is shared. `del` on one node clears that node's L1 and the shared L2;
every other node keeps serving its own L1 copy until the entry expires. With
`TieredCacheStore` that window is `promoteTtl`. Set it to the staleness a route
can tolerate, or give a route that can tolerate none a `RedisCacheStore` with no
L1 in front of it.

## Async options

`CacheModule.forRootAsync` takes a factory, its `inject` list, and the `imports`
those dependencies come from. The dynamic module is its own scope, so importing
`RedisModule` alongside does not reach the factory.

## Hit rate

`CacheModule.forRoot(init, { metrics: true })` binds a `CacheMetrics` and wraps
the configured store in a `MeteredCacheStore` reporting into it:

```ts
export class Ops {
  constructor(private readonly cache: CacheMetrics) {}

  hitRate(): number {
    return this.cache.snapshot().hitRate;
  }
}
```

Hits, misses, per-operation counts and timings, and nothing that holds a key.
[Metrics](./23-metrics.md) has the payload and what the seam does and does not
see.

## A cache that is not running

`RedisCacheStore` throws what the connection throws, so every route behind it
answers 500 while the server is gone. A cached value can be computed again, so
most apps want that outage to cost latency instead.

`DegradingCacheStore` is that, wrapping any store:

```ts
import { DegradingCacheStore, RedisCacheStore } from '@dunx/infra/cache';

new DegradingCacheStore(new RedisCacheStore(redis), { logger });
```

A read answers `undefined`, which `wrap` already treats as a miss and loads
through. A write is dropped rather than queued: a deferred write hands back a
cache that reports a value it never stored. `CacheModule.forRoot(init, {
degrade: true })` wraps the configured store instead of constructing one.

Two things it does not do. **Only a connection error degrades** - a serialisation
failure or a bad command is your bug and still throws, or the cache quietly stops
working and nothing says so. And it **warns once per outage** rather than once
per operation, because an unreachable cache is touched by every cached route.

`degraded` is whatever the last operation set, so a process that has not used the
cache yet reports it healthy. `probe()` does one real read down the same path.
Ask it from a health check:

```ts
export class CacheStoreIndicator extends HealthIndicator {
  readonly name = 'cache';
  override readonly critical = false;

  constructor(private readonly store: DegradingCacheStore) {
    super();
  }

  async check(): Promise<ProbeResult> {
    return (await this.store.probe())
      ? { state: 'up' }
      : {
          state: 'down',
          detail: 'unreachable - reads are answering as misses',
        };
  }
}
```

**Wrap the L2, not the tier.** `TieredCacheStore.set` awaits L2 before L1, so a
throwing L2 blocks the L1 write that would have served the next read; wrapping
from outside swallows the error and loses the promotion with it.
`examples/full` does it this way.
