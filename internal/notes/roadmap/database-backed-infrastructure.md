# A queue, a cache and websocket fan-out with no Redis

Rails 8 replaced Redis with Solid Queue, Solid Cache and Solid Cable, all backed by
the application's own database. This file holds the audit of whether dunx should do
the same: what each of the three layers would cost, what already exists to build on,
and what was measured rather than assumed.

Everything below was probed on Bun 1.4.0 (rev `34cbb9a40`) against Postgres 17. The
measurements live in the architecture docs; this file holds the decision.

Fan-out shipped in 3.1.2, the cache as `@dunx/infra/cache`. Delete this file once
the queue verdict is taken.

## The three layers do not have the same answer

| Layer               | Stands on                                   | Verdict                                |
| ------------------- | ------------------------------------------- | -------------------------------------- |
| Fan-out (Cable)     | `Bun.SQL` `LISTEN`/`NOTIFY`, no library     | **shipped as `PostgresRelay`, 3.1.2**  |
| Queue (Solid Queue) | pg-boss over a `Bun.SQL` adapter            | works, with a shim that is a liability |
| Cache (Solid Cache) | a `CacheStore` in the `ThrottleStore` shape | **shipped as `@dunx/infra/cache`**     |

## Fan-out: shipped in 3.1.2

`PubSubRelay` is two methods, and `Bun.SQL` has both under other names: `notify`,
`listen`, and `unlisten` on the handle. So a relay is a class of about thirty lines
renaming three calls, rather than the structural fit `RedisConnection` is. Two real
dunx nodes, a client on one, a publish on the other: the frame crosses, on the
default `dunx:ws` channel, with `relayChannel` untouched. The measurement and the
7.9 KB frame ceiling are in
[architecture/http.md](../../../docs/architecture/http.md), "A Postgres relay over
`LISTEN`/`NOTIFY`".

The placement question resolved as a `PostgresRelay` beside `RedisRelay` in
`@dunx/http`, released in **3.1.2**. `WsRelay` is the abstract contract both extend
and `WsRelayModule` binds, with `forPostgres`/`forPostgresAsync` beside the Redis
pair, so the backend is a wiring choice and the code that publishes does not change
with it. It landed inside the freeze because `@dunx/http` is one of the core three
and the extension point already existed.

## Queue: it runs, and the shim is the problem

pg-boss 12.28.1 over a `Bun.SQL` adapter completes the full lifecycle - migration,
dispatch, LISTEN/NOTIFY wake, retries - in 10 ms per job, with no `pg` connection
ever opened. Numbers and the connection census that proves the last claim are in
[architecture/queues.md](../../../docs/architecture/queues.md), "A Postgres-backed
queue, measured and not adopted".

The blocker is not performance. Three `Bun.SQL` binding gaps
([bun-apis.md](../../../docs/bun-apis.md)) sit between pg-boss and Bun, and the
adapter closes them by reading the `$n::type` casts out of pg-boss's own SQL. That
is a driver-compat layer maintained here, against another project's queries, failing
silently if either side changes. All three are still live on 1.4.0.

**Two of the three are the gate; the third is not.** Transaction control on a pooled
connection has a workaround the adapter already uses, `sql.reserve()`, so it costs a
few lines rather than blocking. The array binding (#41242) and the JSON cast
(#40942) have none, and both are filed and open. Those two closing is what turns the
adapter into `executeSql` plus `listen`, which is small enough to own.

The second cost does not expire: pg-boss has its own job model, and
`JobPublisher.for()` hands back bullmq's `Queue`. A pg-boss backend is a second
surface, not a driver behind the existing one.

## Cache: shipped as a subpath, without the SQL store

**The gate cleared on a user, not on symmetry.** Issue #78 is from an outside
author asking for local and remote caching. That is what the hold below was
waiting for, and what ROADMAP's "a new package needs a user first" asks. It is a
subpath rather than a package, following the brokers note: `@dunx/infra/cache`
adds no dependency in any position, and an eleventh published workspace for ~250
LOC is the `@dunx/queue-dashboard` mistake.

What shipped, and what was cut:

- **No plugin surface.** The issue asks for "customizable extensions for L1 and
  L2". One abstract `CacheStore` with three implementations answers it: an app
  binds its own subclass through `store`. A registry of named adapters is easy to
  add later and impossible to remove.
- **No SQL store.** The sketch below is not wanted. `MemoryCacheStore` and
  `RedisCacheStore` cover both halves of the request, and a Postgres tier would be
  slower than the Redis one it would sit beside.
- **No cross-process L1 invalidation.** `TieredCacheStore.del` clears this node's
  L1 and the shared L2; every other node serves its own L1 copy until
  `promoteTtl` expires. Pub/sub is the fix and is deferred: a subscribing
  `Bun.RedisClient` holds the event loop open after `close()`, so every app with a
  cache would stop exiting. Tracked with the other loop-hold findings in
  `docs/ROADMAP.md`.
- **No `@Cacheable` decorator.** Not blocked by `inject()` - the mechanism exists,
  and `@dunx/infra/schedule`'s marker plus core's `marked()` is the shipped
  example. Three things make it a later decision: the boot scan reaches only
  `providers` and controllers, so a marked class outside the graph is a silent
  no-op rather than an error; `schedule` _binds_ a method where caching has to
  _replace_ it; and turning arguments into a key is the real policy surface, which
  a decorator would have to answer for every consumer at once.
- **Single flight is in `wrap`.** One `Map<string, Promise<V>>` and a `finally`
  delete. The delete has to be in `finally` or a rejected load is handed to every
  later caller for the life of the process. Dedupe is per process: N replicas on a
  cold key still run N loads.

`ThrottleStore` was **not** reused and the sweep was **not** moved.
`ThrottleStore` is a counter with no value channel and no recency; the only literal
overlap is `MemoryThrottleStore.#sweep`, six lines that walk the whole Map and
`clear()` at the cap, measured at a 59.9 ms stall and already flagged for
replacement. There is also no home for a shared contract: `@dunx/infra` must not
depend on `@dunx/http`, so the only common owner is zero-dependency `@dunx/core`.

## The audit this replaced

dunx has no cache contract at all. Nothing in `packages/*` declares one, so this is
not a second backend for an existing abstraction, it is a new abstraction.

No library clears Rule 1 either. `@keyv/postgres` depends on `pg`; `cache-manager` is
a front for keyv adapters, so every SQL backend under it drags a banned driver in.

Unlike a queue, a TTL cache is not years of edge cases, and dunx has the shape
already: `ThrottleStore` in `@dunx/http` is an abstract class with an in-memory
implementation and a structurally-typed Redis one, and a `CacheStore` would be that
pattern with a SQL implementation added. That makes it buildable and leaves it the
most invented of the three, which is the argument against starting here.

## What the decision actually turns on

The roadmap freezes `infra` to maintenance and says a new package needs a user first,
citing `@dunx/queue-dashboard` as the cost of getting that wrong. The two layers left
sit in or beside frozen ground.

The suggested order, if any of it proceeds:

1. **Watch the two Bun gaps.** Both are still open against 1.4.0, and both closing is
   the gate on the queue adapter being small.
2. **Hold the queue** until the Bun gaps close or someone asks for it.
3. **Hold the cache** until something other than symmetry with Rails argues for it.

## Filed upstream

[oven-sh/bun#40942](https://github.com/oven-sh/bun/issues/40942): a string parameter
bound to a `::json` cast arrives as a JSON string scalar, so
`json_to_recordset($1::json)` fails against a document a `pg`-shaped library already
stringified. `node-postgres` answers `array` for `json_typeof` on the same statement,
which is in the report. Open, and re-measured on 2026-09-03.

**The array half is closed upstream and still fails here, so it is filed afresh as
[oven-sh/bun#41242](https://github.com/oven-sh/bun/issues/41242).** All four of #16840, #17798, #18775 and #22165 are closed as
completed, the last two before 1.4.0 shipped, and what they delivered is `sql.array()`.
Re-measured on 1.4.0 rev `34cbb9a40` against Postgres 17.11: a raw JS array is still
comma-joined under `::text[]` and answers `insufficient data left in message` under
`::int[]`, and `sql.array()` binds `json[]`, so `::int[]` is a cast error and `::text[]`
silently yields elements carrying their JSON quotes. An `INSERT` into a real `text[]`
column stores `"a"` as three characters with no error on either side, which is worse
than the failure the original four described. The evidence is in
[bun-apis.md](../../../docs/bun-apis.md), "Three parameter-binding gaps".

pg-boss writes its own `$n::type` casts, so `sql.array()` does not close the gap for
it. Those two closing is still what turns the queue adapter from a driver-compat
layer into `executeSql` plus `listen`, which is the size worth owning.
