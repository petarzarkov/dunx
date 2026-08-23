# Throttle / rate limiting

Bun 1.3.14, Valkey 8 on 127.0.0.1:6379. Probes in `<SCRATCH>/probes/`.

## Verdict

**Build.** Owning package `@dunx/http`, **root export, no new subpath**. Three reasons it is
`@dunx/http` and not anything else:

1. `@dunx/http` is one of the core three the ROADMAP reserves the work for
   (`docs/ROADMAP.md:32-53`). A new workspace is refused by the same section: "A new package
   needs a user first", with `@dunx/queue-dashboard` as the cost of getting that wrong.
   `@dunx/throttle` would be an eleventh published workspace for ~430 LOC with zero
   dependencies.
2. `@dunx/infra` is refused on dependency direction. A throttler is middleware reading
   `@dunx/http`'s route metadata and `ClientAddress`; putting it in `@dunx/infra` is the fifth
   time that package has been asked to depend on the web layer (`docs/ROADMAP.md:212-219`, and
   `:232-259` for the relay). The Redis store is `Bun.RedisClient` directly, so `@dunx/http`
   gains no dependency, as `RedisRelay` does not.
3. No subpath. `./client` and `./ui` exist for bundle weight; the throttle files import nothing
   beyond `@dunx/core`, `@dunx/http`'s own modules and the `Bun` global, and ESM tree-shaking
   drops them when unused. A subpath would cost a manifest change, a build entrypoint and a
   second `dist/` chunk for no bytes saved.

It fills a gap the docs name: `docs/MIGRATION-FROM-NEST.md:62` lists `@nestjs/throttler` ->
`middleware` -> **undesigned**, and `docs/architecture/http.md:48` already argues throttling is
a global guard plus route metadata rather than per-module.

## What Bun gives us

**`Bun.RedisClient` has 168 own prototype properties and no `eval`, `evalsha`, `multi`,
`pipeline`, `exec`, `watch` or `sendCommand`. It has `send` and `script`.**

```
$ bun probes/redis-methods.ts                    # enumeration, 168 names, then:
eval  undefined | evalsha undefined | script function | send function
multi undefined | pipeline undefined | watch undefined | sendCommand undefined
incr  function  | expire  function  | pexpire function | pttl function

$ bun probes/redis-eval.ts
EVAL via send -> 1 number | EVALSHA -> 2 | numeric arg -> 1
SCRIPT LOAD -> f793247de6e1e3c553cd42d39c812df499e679e4
multi-return -> [1,1000,5] true
MULTI -> OK | INCR -> QUEUED | EXEC -> [1]
```

A Lua table returns as a JS array, so one script returns `[allowed, retryAfterMs, remaining,
resetMs]` in one round trip. This decides the design: an atomic compare-and-set is available, so
the limiter is correct under concurrency without the `WATCH` Bun does not expose. `MULTI`/`EXEC`
work through `send` and are unused, since auto-pipelining shares the socket and interleaved
transactions from concurrent callers are a hazard a single `EVAL` does not have.

**`script()` exists at runtime but is not declared in bun-types 1.3.14**, so calling it is a
compile error. `send` is declared, as `send(command: string, args: string[]): Promise<any>`. The
design uses `send('SCRIPT', ['LOAD', src])`. Worth a line in `docs/bun-apis.md`. `NOSCRIPT`
arrives with a generic `code`, so the reload path matches the message.

```
$ bunx tsc --ignoreConfig --noEmit --strict --types bun probes/types-check.ts
probes/types-check.ts(2,22): error TS2339: Property 'script' does not exist on type 'RedisClient'.
$ bun probes/redis-noscript.ts
200 parallel EVAL: min 1 max 200 unique 200      # atomic, correctly pipelined
EVALSHA after FLUSH threw: Error | code= ERR_REDIS_INVALID_RESPONSE | msg= NOSCRIPT No matching script.
$ bun probes/final.ts                            # reload on NOSCRIPT, replay once
before flush -> [1,0,4,200]
after  flush -> [1,0,3,398] (reload path worked, new sha 286c024c)
```

**The event-loop hold is narrower than the ROADMAP entry implies, and a command-only client is
on the safe side of it.** Each run under `timeout 12`:

| Case                                                                       | Exit               |
| -------------------------------------------------------------------------- | ------------------ |
| connect, EVAL, `close()` / never connected / failed connect / never closed | 0 in 21-49 ms      |
| `subscribe()` then `close()`                                               | **124, hung 12 s** |
| `autoReconnect: true` against absent server, `close()` mid-retry           | **124, hung 10 s** |

A throttle store never subscribes, so it avoids row 2. Row 3 is reachable: the store must not open
its own connection with a reconnect budget at boot. **Costs measured** across `probes/{gcra-memory,memory-cost,response-headers,final,lua-algos}.ts`,
`Bun.nanoseconds()` over 1M iterations after a 20k warm-up.

| Operation                                                     | Cost                                      |
| ------------------------------------------------------------- | ----------------------------------------- |
| In-memory GCRA `take`, 1 key / 1k keys / 100k keys            | 0.040 / 0.054 / **0.159 us**              |
| `Date.now()` / template key build                             | 0.063 / 0.035 us                          |
| `Response.json` + 2 header sets, minus `Response.json` alone  | 1.329 - 0.577 = 0.752 us                  |
| **Full in-memory request path, 100k identities**              | **~0.30 us**                              |
| 100k entries in memory / as Redis keys                        | 16.1 MB (163 B each) / 6.6 MB (66 B each) |
| Full-`Map` sweep of 100k expired / incremental, budget 1000   | **59.9 ms stall** / 1.2 ms                |
| EVALSHA sequential round trip / 1000 concurrent               | 273 us / 9.1 us amortised                 |
| EVAL full source / EVALSHA fixed-window / GCRA / `INCR` floor | 19.0 / 11.2 / 9.9 / 2.5 us pipelined      |

Two rows drive design: the two response headers cost more than the meter does, and a naive
full-`Map` sweep stalls for 59.9 ms. End to end the in-memory path is below the noise floor: a
serial `fetch` loop against `Bun.serve` measured 348.11 us/req plain and 314.82 us/req throttled
(`probes/e2e.ts`), a -9.6% difference that is the client, not a speedup. Report the 0.30 us, not
an end-to-end number.

**What Bun does not have.** No rate limiting of any kind: `Bun.serve` has no such option and the
only match for `ratelimit` across bun-types 1.3.14 is a WebSocket close-code comment. No native
LRU or TTL cache: `Bun.LRU`, `Bun.LRUCache`, `Bun.TTLCache` are all `undefined`, and
`Bun.unsafe` holds only `gcAggressionLevel`, `arrayBufferToString`, `mimallocDump`. `WeakRef`
and `FinalizationRegistry` exist but do not help, since a rate-limit entry has no owning object
to be weak against. No client-side `WATCH`, no pipeline builder. So the in-memory store is a
plain `Map<string, number>`.

## Library decision

**No library. `rate-limiter-flexible` was checked and rejected on the client surface, not on
principle.**

```
$ bun pm view rate-limiter-flexible
rate-limiter-flexible@11.2.0 | ISC | deps: 0 | versions: 195
$ grep -n "client\." node_modules/rate-limiter-flexible/lib/RateLimiterRedis.js
34:    if (typeof this.client.defineCommand === 'function') {
118:    const multi = this.client.multi();
155:  this.client.eval(this._incrTtlLuaScript, 1, rlKey, ...)
```

It requires `multi()`, `defineCommand()`, `eval()` and a `status`/`isReady` probe.
`Bun.RedisClient` has none of the four. Using it means installing `ioredis`, which Rule 1 bans
because `Bun.RedisClient` exists, or writing an ioredis-shaped adapter larger than the limiter
it wraps. `RateLimiterValkey` and `RateLimiterValkeyGlide` are for `iovalkey` and
`valkey-glide`, the same problem. `@upstash/ratelimit` speaks Upstash REST, not Redis. Following
the bullmq precedent, the check ran before the conclusion: no rate-limit library ships a
`Bun.RedisClient` adapter today. Rule 1's second half asks whether this is an ORM-shaped
problem. It is not: the meter is one arithmetic expression over one number, and the algorithm is
published (GCRA). There is no schema layer, no migration story, no protocol and no years of edge
cases. Compare `bullmq`, which owns retries, backoff, priorities, cron and stall recovery, and
where the library was taken. `@dunx/http` gains zero dependencies.

## Public API

Algorithm: **GCRA** (generic cell rate algorithm, a leaky bucket as a meter). One key holding
one number, the theoretical arrival time. All four candidates were implemented and run against
Valkey in `probes/lua-algos.ts`:

| Algorithm              | State per identity                  | Accuracy                          |
| ---------------------- | ----------------------------------- | --------------------------------- |
| Fixed window           | count + expiry                      | admits 2x limit across a boundary |
| Sliding window log     | one timestamp per request, O(limit) | exact                             |
| Sliding window counter | 2 counters, 2 keys                  | ~0.1% error, no 2x burst          |
| **GCRA**               | **1 number, 1 key**                 | exact, ms-precision `Retry-After` |

GCRA is the only one whose atomic step is a single compare-and-set on one value, so the Redis
script and the `Map` implementation run identical arithmetic and cannot disagree. Sliding window
log is refused on memory: 100k identities at limit 100 is 10M timestamps. Correctness, 5 per
1000 ms, burst of 7:

```
$ bun probes/gcra-memory.ts
5-per-1000ms burst of 7: Y/r4/ra0 Y/r3/ra0 Y/r2/ra0 Y/r1/ra0 Y/r0/ra0 N/r0/ra200 N/r0/ra200
after 400ms: {"allowed":true,"remaining":1,"resetMs":800,"retryAfterMs":0}
```

```ts
type Policies = Readonly<Record<string, ThrottlePolicy>>;
export class ThrottlePolicy {
  readonly limit: number;
  readonly windowMs: number;
  /** Admitted in one instant before the meter throttles. @default limit */
  readonly burst: number;
  constructor(init: { limit: number; windowMs: number; burst?: number });
  /** windowMs / limit. The interval GCRA meters against. */
  get emissionMs(): number;
}
export class ThrottleDecision {
  constructor(
    readonly allowed: boolean, readonly remaining: number,
    readonly resetMs: number, readonly retryAfterMs: number,
  ) {}
}
/** Abstract class, not the interface `PubSubRelay` is: see the note below. */
export abstract class ThrottleStore {
  abstract take(
    key: string, policy: ThrottlePolicy, now: number,
  ): ThrottleDecision | Promise<ThrottleDecision>;
}
export class MemoryThrottleStore extends ThrottleStore {
  constructor(init?: { maxKeys?: number; sweepBudget?: number });
  take(key: string, policy: ThrottlePolicy, now: number): ThrottleDecision;
  get size(): number;
}
/** Restated the way `RedisProbe` and `RedisStore` are. `RedisConnection` satisfies it. */
export interface ThrottleBroker {
  send(command: string, args?: readonly string[]): Promise<unknown>;
}
export class RedisThrottleStore extends ThrottleStore {
  constructor(broker: ThrottleBroker, init?: { prefix?: string });
  take(key: string, policy: ThrottlePolicy, now: number): Promise<ThrottleDecision>;
}
/** `undefined` skips the request rather than sharing one bucket across strangers. */
export type ThrottleKey = (
  req: BunRequest, ctx: RouteContext, ip: string | undefined,
) => string | undefined;
export interface ThrottleOptionsInit {
  readonly policies?: Policies;
  readonly store?: ThrottleStore;          // @default new MemoryThrottleStore()
  readonly key?: ThrottleKey;              // @default ip + method + route path
  readonly headers?: 'draft' | 'legacy' | false;  // @default 'draft'
  readonly failOpen?: boolean;             // allow when the store throws. @default true
  readonly countUnmatched?: boolean;       // count route misses. @default false
  readonly onError?: (error: unknown, key: string) => void;
  /** Binds this subclass instead of `ThrottleGuard`, for a second guard in one app. */
  readonly as?: Ctor<ThrottleGuard>;
}
/** A class, so `@dunx/transform` can record it as a constructor parameter type. */
export class ThrottleOptions {
  constructor(init?: ThrottleOptionsInit);
  readonly policies: Policies;
  readonly store: ThrottleStore;           /* ...the rest, resolved */
}
/** Every parameter is a runtime class, so none records as `unresolved`. */
export class ThrottleGuard implements Middleware {
  constructor(
    private readonly options: ThrottleOptions,
    private readonly address: ClientAddress,
    private readonly context: RequestContext,
  );
  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response>;
}
/** Binds and exports `ThrottleOptions` and `ThrottleGuard`; neither self-binds. */
export class ThrottleModule {
  static forRoot(init?: ThrottleOptionsInit): DynamicModule;
  static forRootAsync(config: FactoryProvider<ThrottleOptionsInit, Deps>): DynamicModule;
}
export const THROTTLE: MetaKey<Policies>;
export const SKIP_THROTTLE: MetaKey<readonly string[] | true>;
/** Method or class decorator. Merges over the module default per named policy. */
export const Throttle: (
  policies: Readonly<Record<string, { limit: number; windowMs: number; burst?: number }>>,
) => <F extends object>(target: F) => F;
/** No argument skips every policy; named arguments skip those. */
export const SkipThrottle: (...names: readonly string[]) => <F extends object>(target: F) => F;
```

`ThrottleStore` is an abstract class rather than the interface `PubSubRelay` is:
`MemoryThrottleStore` owns a Map and a sweep cursor, which is Rule 3's first bullet, and a
runtime value can also be bound as a provider by an app supplying its own. It has no private
members, so a plain object with one `take` satisfies the type structurally, the way
`RedisConnection` satisfies `@dunx/auth`'s `RedisStore`.

`Throttle` and `SkipThrottle` are `meta(THROTTLE, ...)` and `meta(SKIP_THROTTLE, ...)` over the
existing `metaKey`/`meta` pair, and the guard reads them with `ctx.get(THROTTLE)`, the mechanism
`SessionGuard` uses for `PUBLIC` and `ROLES`. No second metadata channel, and both are TC39
method-or-class decorators returning the target. Named policies, per-route override and the
module default compose in one place:

```ts
ThrottleModule.forRoot({
  policies: {
    short: new ThrottlePolicy({ limit: 10, windowMs: 1_000 }),
    long: new ThrottlePolicy({ limit: 300, windowMs: 60_000 }),
  },
});

@Controller('/notes')
@Throttle({ long: { limit: 100, windowMs: 60_000 } }) // class-level: this controller
export class NotesController {
  @Get('/') @SkipThrottle('short') list() {} // route-level: keeps `long`
  @Post('/x') @Throttle({ short: { limit: 1, windowMs: 5_000 } }) run() {}
}
```

`mergeMeta(klass, handler)` resolves handler-over-class at boot, so the guard does one `Map`
lookup per request and merges nothing at request time. `@Module({ middleware: [ThrottleGuard]
})` scopes it to that module's own controllers: `factory.ts:97` reads
`module.options.middleware` inside the per-module loop and stamps it onto only that module's
routes, and `routes.ts:306` resolves each entry from the declaring module's scope, so it can
inject that module's private providers. A module-scoped guard skips the not-found fallback,
since `buildFallback` runs global middleware only. Global registration is
`app.use(ThrottleGuard)` or `HttpFactory.create(root, { middleware: [ThrottleGuard] })`. The
chain is `RequestLoggingMiddleware` -> `HttpOptions.middleware` -> `app.use()` in call order ->
module middleware -> class `@UseGuards` -> method `@UseGuards` -> handler.

**Ordering, stated explicitly. Two throttle guards, not one:**

```
RequestLoggingMiddleware      establishes RequestContext, so userId has somewhere to land
ThrottleGuard                 IP-keyed. Before any session lookup.
SessionGuard                  AuthContext.run writes userId into RequestContext
UserThrottleGuard             user-keyed. Only here does the principal exist.

export class UserThrottleGuard extends ThrottleGuard {}
ThrottleModule.forRoot({ policies: { ip: ipPolicy } });
ThrottleModule.forRoot({ as: UserThrottleGuard, policies: { user: userPolicy },
                         key: (_req, _ctx, ip) => userIdOr(ip) });
```

A user-keyed limiter needs the principal, and `@dunx/http` cannot import `@dunx/auth`. It does
not have to: `AuthContext.run` calls `this.context.updateContext({ userId: principal.user.id })`
on `@dunx/core`'s `RequestContext`, which `ThrottleGuard` already injects, so the key extractor
reads `this.context.getContext().userId`. A single user-keyed guard after `SessionGuard` would
authenticate an unauthenticated flood before throttling it, one session lookup per attack
request. The second guard is a subclass because `app.use` takes `Ctor<Middleware>` and a `Token`
is not one; `readDeps` walks the prototype chain, so a subclass with no constructor of its own
inherits the base's recorded dependencies. Two `forRoot` calls with different `as` build two
scopes, one per configuration, the way `RedisModule.forRoot({ name })` does.

**Response.** `429` written by the middleware, not thrown. `HttpError(status, message)` carries
no headers and `errorMapper` emits `Response.json({ error, status }, { status })` with none, so
`Retry-After` would be dropped, and a custom `onError` replaces the mapper outright, so the
headers would then depend on the app's error handler. The allowed path also has to set headers
on the response `next()` returned, which only a wrapping middleware can do. One code path for
both, and response headers are mutable after construction, including one that came back from
`fetch` (`probes/response-headers.ts`). The body matches the error path's shape:
`{"error":"TOO_MANY_REQUESTS","status":429}`.

Headers: `Retry-After` (integer seconds, per RFC 9110) plus the IETF draft pair. **The IETF
fields are not standardised.** `draft-ietf-httpapi-ratelimit-headers-11`, 23 May 2026, is an
active Internet-Draft in the httpapi working group, not an RFC. It defines two structured
fields, `RateLimit` and `RateLimit-Policy`; the `RateLimit-Limit` / `-Remaining` / `-Reset`
triple comes from earlier, superseded revisions of the same draft and survives as deployed
convention. Since neither set is a standard, the default emits the current draft's pair
(`RateLimit: "short";r=7;t=1`, `RateLimit-Policy: "short";q=10;w=1`) and `headers: 'legacy'` the
older triple prefixed `X-RateLimit-`.

## Where it lives

All under `packages/http/src/throttle/`, one `*.test.ts` per file:

| File            | Purpose                                                                     |
| --------------- | --------------------------------------------------------------------------- |
| `policy.ts`     | `ThrottlePolicy`, `ThrottleDecision`, the GCRA arithmetic both stores share |
| `store.ts`      | `ThrottleStore` abstract class, `ThrottleBroker` restatement                |
| `memory.ts`     | `MemoryThrottleStore`: one `Map`, incremental sweep                         |
| `redis.ts`      | `RedisThrottleStore`: the Lua script, `SCRIPT LOAD`, `NOSCRIPT` reload      |
| `options.ts`    | `ThrottleOptions` class, `ThrottleOptionsInit`, defaults                    |
| `decorators.ts` | `THROTTLE`, `SKIP_THROTTLE`, `Throttle`, `SkipThrottle`                     |
| `guard.ts`      | `ThrottleGuard`: key, take, headers, 429                                    |
| `module.ts`     | `ThrottleModule.forRoot` / `forRootAsync`                                   |

**Exports map and manifest: no change.** Everything is re-exported from
`packages/http/src/index.ts`, alongside `RequestLoggingMiddleware`, `RedisRelay` and
`ClientAddress`. No new dependency, no new peer, no new subpath, so `build-package.ts` derives
the same entrypoints it does today.

One Rule 2 correction ships with it: `docs/guide/05-controllers.md:556` publishes `RATE_LIMIT` /
`@RateLimit` as the teaching example for `metaKey`. Once `@dunx/http` ships `THROTTLE`, that
teaches a second declaration of a concept the framework owns. Retarget it to something the
framework does not ship, in the same change.

## What it refuses

- **No queue, no wait, no delay.** A denied request gets 429 immediately. No `RateLimiterQueue`
  equivalent holding a request open until a slot frees, which turns a limiter into a source of
  held connections.
- **No sliding window log**, no per-request timestamp list. **No per-route store**, one per
  guard. **Not a WAF**: no ban lists, allow lists, CAPTCHA hook or user agent rules.
- **No second `X-Forwarded-For` parser.** The IP comes from `ClientAddress.of(req)`.
- **No connection of its own.** `RedisThrottleStore` takes a broker the app already owns and
  never calls `close()`, so it cannot reach the `autoReconnect` hang that row 3 of the loop-hold
  table shows a boot-time `new Bun.RedisClient` buying.
- **No dashboard panel.** `@dunx/dashboard` is frozen to maintenance (`docs/ROADMAP.md:32-53`)
  and a limiter panel would be the queue table again.
- **No `enum`, no `any`, no parameter decorators.** `send` is typed `Promise<any>` by Bun;
  `RedisThrottleStore` assigns it to `unknown` and narrows, as `RedisConnection.send` already
  does.

## Risks and open spikes

1. **`ClientAddress` is not trustworthy enough to key a limiter on, in either setting. This is a
   prerequisite, not a risk.** With `trust proxy: false` it returns
   `server.requestIP(req)?.address`, which behind any proxy is the proxy, so the whole fleet
   shares one bucket. With `trust proxy: true` it takes
   `headers.get('x-forwarded-for')?.split(',')[0]?.trim()`, the leftmost entry, which is the
   client-appendable end: a caller sending `X-Forwarded-For: 1.2.3.4` gets `1.2.3.4, <real ip>`
   once the proxy appends, and the limiter keys on the value the attacker chose. Rotating that
   header is unlimited free quota. The fix belongs in `ClientAddress` at the lowest common
   owner, as a hop count counted from the right, and it improves request logging too. **Spike it
   before the guard**; until it exists `ThrottleGuard` logs one boot warning when `trust proxy`
   is true with no hop count.
2. **A full-`Map` sweep stalls the event loop for 59.9 ms at 100k keys** (measured).
   `MemoryThrottleStore` sweeps incrementally from a saved cursor: budget 1000 costs 1.2 ms.
   Unmeasured is whether that keeps up with the arrival rate at 1M identities; needs a `maxKeys`
   ceiling and a decision on what happens at it.
3. **GCRA's `remaining` is derived, not counted.** The first Lua draft returned `remaining: 4`
   on a denied request (`probes/lua-algos.ts`, `[0,198,4]`); the corrected in-memory version
   returns 0. Both stores must be tested against one table of expected `[allowed, remaining,
resetMs, retryAfterMs]`.
4. **Redis and memory can disagree on clock.** The Lua script takes `now` from the caller, not
   `redis.call('TIME')`, which keeps it deterministic and replica-safe but means two app nodes
   with 500 ms of skew meter differently. Unmeasured: how much skew matters at a 1 s window.
5. **`Retry-After` in integer seconds loses GCRA's precision.** A 198 ms wait rounds up to 1 s.
   Stated behaviour, no spike. If the draft renames its fields, `headers` is the hedge and a
   rename is one function.

## Cost

| Item                    | Estimate                                                                                                                                                                                                                                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New source files        | 8 in `packages/http/src/throttle/`, plus 8 tests                                                                                                                                                                                                                                                     |
| Source LOC              | ~430 total, largest file ~90 (`guard.ts`); test LOC ~600                                                                                                                                                                                                                                             |
| Edits to existing files | `packages/http/src/index.ts` (re-exports); `server/client-address.ts` + `server/settings.ts` for spike 1                                                                                                                                                                                             |
| New dependencies        | none, in any position                                                                                                                                                                                                                                                                                |
| Manifest changes        | none                                                                                                                                                                                                                                                                                                 |
| Docs pages              | one new `docs/guide/` page; `docs/architecture/http.md` gains a throttling section; `docs/bun-apis.md` gains the undeclared `script()` and the narrowed loop-hold table; `docs/MIGRATION-FROM-NEST.md:62` moves off `undesigned`; `docs/guide/05-controllers.md:556` retargets its `metaKey` example |
| Example changes         | `examples/full` only. A global IP guard plus one `@Throttle` route. It already skips cleanly when Redis is absent, which the memory-store default fits                                                                                                                                               |
| CI impact               | no new job. Redis-backed tests skip on an absent broker like the existing ones; guard and memory-store tests need no service                                                                                                                                                                         |
| README                  | `packages/http/README.md` gains a section; `bun run gen:readme` regenerates the root table unchanged, since no workspace is added                                                                                                                                                                    |
