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

The snapshot holds hits, misses, and counts and timings per operation. It holds
no keys. [Metrics](./24-metrics.md) lists the payload and what it covers.

## A cache that is not running

`RedisCacheStore` throws what the connection throws, so every route behind it
answers 500 while the server is gone. A cached value can be computed again, so
most apps want that outage to cost latency instead.

`DegradingCacheStore` is that, wrapping any store:

```ts
import { DegradingCacheStore, RedisCacheStore } from '@dunx/infra/cache';

new DegradingCacheStore(new RedisCacheStore(redis), { logger });
```

During an outage a read returns `undefined`, which `wrap` treats as a miss, so
it loads the value. A write is dropped, not queued, so the cache never reports a
value it did not store. `CacheModule.forRoot(init, { degrade: true })` wraps the
configured store for you.

Two things it does not do. **Only a connection error degrades** - a serialisation
failure or a bad command is your bug and still throws, or the cache quietly stops
working and nothing says so. And it **warns once per outage** rather than once
per operation, because an unreachable cache is touched by every cached route.

The default `degradable` predicate is `isConnectionError`, which matches only
Bun's Redis connection error code. For a store on another backend, pass your own
`degradable`; without one, every failure still throws.

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

Create the indicator with `new`. `degrade: true` wraps the store inside the cache
module and does not bind `DegradingCacheStore`, so an injected one would not be
the store your routes use. Build the store on a provider of your own and pass it
to the indicator in the health factory:

```ts
export class CacheL2 {
  readonly store: DegradingCacheStore;

  constructor(redis: RedisConnection, logger: Logger) {
    this.store = new DegradingCacheStore(new RedisCacheStore(redis), { logger });
  }
}

// in HealthModule.forRootAsync's factory, with CacheL2 injected
readiness: [new CacheStoreIndicator(cache.store)],
```

**Wrap the L2 store, not the `TieredCacheStore`.** `TieredCacheStore.set`
writes L2 first, then L1. If L2 throws, L1 is never written. Wrapping the whole
tier hides the error, but the value still does not reach L1, so the next read
misses. `examples/full` wraps the L2.

## ETags and conditional GET

`etag` tags what a `GET` route returns, and answers `If-None-Match` with a 304:

```ts
const app = await HttpFactory.create(AppModule, { etag: true });
```

```
GET /api/colors                                  200  ETag: W/"8e0f5c2a91d4b7e3"
GET /api/colors  If-None-Match: W/"8e0f5c2a91d4b7e3"  304  no body
```

| Handler returns             | With `etag` on                                                    |
| --------------------------- | ----------------------------------------------------------------- |
| a value, at status 200      | `ETag` of the JSON bytes, and a 304 when `If-None-Match` names it |
| a value, at another status  | untouched                                                         |
| a `Response` with an `ETag` | its tag kept, and a 304 when `If-None-Match` names it             |
| a `Response` without one    | untouched: a file, a stream or an `@Sse` route is never read      |

`etag` is off by default. On `HttpOptionsProvider` it is a getter, `get etag()`.
With `etag` off, a handler can still return `conditionalGet(response, req)` to
get the 304. `entityTag(body, weak)` computes the same tag `etag` would.
`@dunx/openapi` uses both for its document.

- **Weak by default**, `W/"..."`, as in Express. `{ etag: { weak: false } }`
  sends strong tags. `If-None-Match` compares weakly either way (RFC 9110
  13.1.2), so `W/"a"` matches `"a"`, and `*` matches any 200.
- **The tag is xxHash3 of the body, seed 0**, so every replica sends the same
  tag for the same bytes. It costs 0.03 us for 1 KB and 13.5 us for 1 MB.
- **`HEAD` gets the tag `GET` has.** Bun answers `HEAD` from the `GET` handler.
- **A 304 keeps the 200's headers** without its body or `content-length`. CORS,
  `securityHeaders`, `traceresponse`, a version's `Vary` and any
  [cookie](./35-cookies.md) the handler set are on it.
- **Under `Compression` the tag describes the unencoded bytes**, so gzip, zstd
  and identity share one. `Compression` weakens a strong tag it encodes, skips a
  304 and adds `Vary: accept-encoding` to it.
- **`If-Match` is not evaluated.** A precondition on a `PUT` has to be checked
  before the write, and the tag is known only from the response after it. Read
  the header in the handler and throw `HttpError(HttpStatusCode.PRECONDITION_FAILED)`.
  `If-Modified-Since` is ignored too, since no `Last-Modified` is sent.

A 304 still runs the handler, because the tag is computed from its result. If
the value is expensive to build, cache it with `Cache` above; `etag` only saves
the transfer.
