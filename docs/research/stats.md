# Stats and metrics

## Verdict

**Build the collection on Bun's native histogram. Refuse the exposition. Add no package.**

- **Bun ships a native HDR histogram.** `node:perf_hooks.createHistogram()` works under Bun
  1.3.14: `record()` costs **10.7 ns** at a p99 error of **-0.01%**, against 25.5 ns for a
  hand-rolled 12-bucket scan that returns bucket edges instead of percentiles, and 655.9 ns
  for `prom-client`'s. The repo has **zero** `node:perf_hooks` call sites today.
- **Bun ships a native in-flight gauge.** `server.pendingRequests` reads in 14.65 ns, verified
  at 20 during 20 concurrent slow requests and 0 idle, so dunx counts nothing. **And no GC
  hook exists:** `PerformanceObserver.supportedEntryTypes` is `["mark","measure","resource"]`.
- **The per-request cost is 35.2 ns**, 0.65% of request logging's 5.38 us, called from the
  `.then` `RequestLoggingMiddleware` already allocates; 175.9 ns standalone.

Exposition is refused. A Prometheus text writer is 30 lines that then grow `le` bucket ordering,
`NaN`/`+Inf` literals, label quoting, OpenMetrics and content-type negotiation:
`@dunx/queue-dashboard` again. dunx serves one JSON sibling in the shape the dashboard already
uses, and a README recipe pumps it into the consumer's own `prom-client` registry. **And no new
package:** `docs/ROADMAP.md`, "Priority: the core three", freezes peripheral surface, and "a new
package needs a user first" names the `@dunx/queue-dashboard` round trip as the argument. Runtime
readers land in `@dunx/core`, the request half in `@dunx/http`.

### The Rule 2 answer, which comes first

`process.memoryUsage()` has **exactly one call site in shipped code**:
`packages/dashboard/src/api/runtime.ts:64`, inside `memory()` at `:63-71`. The health module being
designed in parallel wants the same numbers (`scratchpad/research/health.md:53`), so this would be
the third consumer - the `providersOf` / `modulesOf` trigger. Those sit at
`packages/core/src/di/graph.ts:158` and `:207`, and the comment at
`packages/core/src/di/index.ts:37-40` says they are there "because a second consumer exists:
`@dunx/dashboard`", with `@dunx/mcp` re-exporting them (`tools/mcp/src/index.ts:13-23`).

The dashboard already computes `memory` from `process.memoryUsage()` (`api/runtime.ts:63-71`),
`pid` (`:83`), `uptimeMs` as `performance.now() - startedAt` with the mark at
`middleware.ts:46` (`:87`), `bun`/`platform`/`arch` (`:88-90`), and probe plus Redis-ping
latency from `performance.now()` pairs (`:32,38,54,58`, `api/redis.ts:56,69`), and declares
`MemoryReport`/`RuntimeReport` at `api/types.ts:70-75`, `:78-88`.

**A stats provider feeds the dashboard; the dashboard keeps nothing of its own.** Its runtime
panel calls core's `RuntimeStats`, a direct dependency it already has
(`packages/dashboard/package.json:69-70`). Request metrics arrive the way queues do: a
`StatsSource` in `contracts.ts` restating what `RequestMetrics.snapshot()` returns, satisfied
structurally, passed as `stats: metrics`. The manifest has **no `dependencies` key at all**, so a
structural restatement is required, not preferred.

**One thing must not move.** `internal/bench` hand-rolls a 100,000-bucket `Uint32Array` histogram
(`internal/bench/src/loadgen/protocol.ts:9`) plus `percentileFrom` (`:29`), and `stats.ts:3,11,20`
computes median/stddev. That reads like a Rule 2 duplicate and is not one: the array is
**transferred over `postMessage`** from the load workers
(`internal/bench/src/loadgen/fetch-worker.ts:67,73`), which a native `Histogram` cannot cross.
Record the reason so nobody "fixes" it.

## What Bun gives us

Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`), Linux x64, WSL2. Costs are
`Bun.nanoseconds()` over a warmed loop; probes in `<SCRATCH>/probes/stats/`.

```
$ bun probes/stats/02-memory-cost.ts
Bun.nanoseconds()      0.075 us   jsc.heapSize()                    2.965 us
performance.now()      0.047 us   jsc.memoryUsage()                 8.289 us
process.memoryUsage()  7.408 us   jsc.heapStats()                7040.518 us
process.resourceUsage()1.011 us   jsc.totalCompileTime()            0.019 us
process.cpuUsage()     0.630 us   Bun.unsafe.gcAggressionLevel()    0.017 us
$ bun probes/stats/09b.ts -> v8.getHeapStatistics() 1075.997 us warm, 7605.660 us hot
```

| Call | Cost | Shape | Use |
| --- | --- | --- | --- |
| `process.memoryUsage()` | 7.41 us | `{rss, heapTotal, heapUsed, external, arrayBuffers}` | **Yes.** The whole answer. |
| `process.resourceUsage()` and `process.cpuUsage()` | 1.01 / 0.63 us | 16 fields (`maxRSS`, page faults, context switches) and `{user, system}` microseconds | **Yes.** Both 7-12x cheaper than `memoryUsage()`. |
| `bun:jsc.heapStats()` | **7040 us** | 80 type counts, 13809 JSON bytes | **No.** 7.3-12.1 ms on a 50k-object heap; grows with it. |
| `node:v8.getHeapStatistics()` | **1076-7606 us** | 14 V8-named fields | **No.** Milliseconds, and the names describe a heap Bun lacks. |

Also rejected, each for one measured reason: `process.memoryUsage.rss()` costs the same 6.55 us as
the full object; `process.uptime()` counts from interpreter start, where
`performance.now() - startedAt` is what `runtime.ts:84` argues for; `bun:jsc.memoryUsage()` (8.29 us) adds only `peak`;
`bun:jsc.heapSize()` (2.97 us) equals `heapUsed`; `percentAvailableMemoryInUse()` returns
**`null`** and `totalCompileTime()` **`0`**; and `node:v8`'s
`getHeapSpaceStatistics()`/`getHeapCodeStatistics()` throw. Of `bun:jsc`'s 37 exports the other 33
are compiler/debugger tools.

**`Bun.unsafe` has three properties and none is a metric; heap snapshots cost ~700 ms.**

```
$ bun probes/stats/01-memory-shapes.ts   # Bun.unsafe own props, incl. non-enumerable
gcAggressionLevel / arrayBufferToString / mimallocDump: function, enumerable=true, length=1
$ bun probes/stats/03b-mimalloc-capture.ts
stdout bytes: 0 stderr bytes: 1299
$ bun probes/stats/04-heapsnapshot.ts         # heap holding 50k objects
Bun.generateHeapSnapshot()  964528.5 us, 10157638 JSON bytes; repeated 704836/679032/766197
```

`mimallocDump()` **writes a text table to fd 2 and returns `undefined`** - nothing is readable
in-process. The table helps a human (`reserved: 1.0 GiB`, `peak rss: 63.0 MiB`) and is unusable as
a metric: reading it means spawning a subprocess to parse a table with no stability promise.
`gcAggressionLevel()` is a setter returning the previous level, and the snapshots block the loop
for their whole ~700 ms: not on a route, not behind a flag.

**Event loop lag is native and accurate. GC has no hook.**

```
$ bun probes/stats/12-lag-reliability.ts
blocking 300ms; a working monitor should report max >= ~280ms
warmup 0ms,   settle 300ms   max=6.2ms n=14   max=7.9ms n=13   max=1.6ms n=14 ...
warmup 200ms, settle 300ms   max=291.4ms n=23 max=292.2ms n=23 max=296.2ms n=22 ...
with a competing setInterval: max=290.8ms n=23 ticks=24
$ bun probes/stats/08-gc.ts
observe({entryTypes:["gc"]}) did not throw
supportedEntryTypes: ["mark","measure","resource"]
gc entries observed after forcing GC: 0
```

`monitorEventLoopDelay` returns the same native `Histogram`, records nanoseconds, and reported
279-299 ms for a 300 ms block across 20 trials. **One caveat, found by repeating the trial:** a
block in the same event-loop turn as `enable()` is missed (1.6-7.9 ms for a 300 ms block), so
enable at boot rather than at scrape time. Overhead is at the noise floor, 1.445 vs 1.683 ns/iter,
and it does **not** hold the loop open - `10-loop-hold.ts` exits 0 with and without `disable()`,
worth stating given the `Bun.RedisClient` precedent in `bun-apis.md`. A `setTimeout`-delta
implementation is worse: on an idle loop it reported 0.344-5.530 ms of "lag" that is timer
coalescing, and `performance.eventLoopUtilization` and `performance.nodeTiming` are both
**`undefined`**. The GC observer never fires while `perf_hooks.constants` still carries
`NODE_PERFORMANCE_GC_*`, confirmed independently by prom-client's `nodejs_gc_duration_seconds`
emitting two header lines and **zero samples**.

**`record()` beats every alternative, and `Bun.serve` already counts in-flight requests.**

```
$ bun probes/stats/07-record-cost.ts
perf_hooks Histogram.record(number)          0.0108 us (10.8 ns)
fixed 12-bucket linear scan + sum            0.0255 us (25.5 ns)
Map counter get+set 0.0235 us | plain field increment 0.0094 us
read side: percentile(99) 3.1879 | count 0.0116 | mean 56.8146 | percentiles 41.9191 us
$ bun probes/stats/19-hist-mem-clean.ts
createHistogram()  [Node defaults]        11.3 KiB each   (4000 held)
{lowest:1, highest:60e9, figures:3}      218.9 KiB each   (4000 held)
$ bun probes/stats/15-bunserve-counters.ts
proto: ... pendingRequests, pendingWebSockets, port, publish, requestIP, subscriberCount
idle pendingRequests: 0   during 20 slow: 20   after settle: 0   us/read: 0.01465
own=[] params={"id":"42"} route=undefined pattern=undefined
```

Accuracy over a uniform 1..10000: p50 5003, p90 9007, p99 9903, all within 0.08%. Four
behaviours a wrapper must handle, each measured:

| Behaviour | Detail |
| --- | --- |
| `record(0)` and `record(-1)` throw | `RangeError [ERR_OUT_OF_RANGE]: value is out of range (must be >= 1)`. A sub-microsecond duration must clamp to 1. |
| Empty-histogram sentinels | After `reset()`: `min` is `9223372036854776000`, `mean` is `NaN`, `max` is 0. Never serialise a `count === 0` histogram. |
| `percentiles` holds BigInt, and there is no `toJSON()` | Keys `number`, values `bigint`; `JSON.stringify` throws, so use `percentile(n)`, which returns a `number`. Node's `Histogram.toJSON` is absent under Bun. |

**`mean` costs 56.8 us and `stddev` 101 us per histogram** (2424 us for 24), so both stay out of
the snapshot and `percentile()` at 3.19 us is what gets used. **Explicit bounds cost 8-19x the
memory of passing none**, pre-allocating the full bucket array where the defaults grow lazily; the
defaults also record faster (10.7 vs 16.0 ns) and are equally accurate. So `createHistogram()`
with no options, ~16 KiB per series, recording raw nanoseconds. `BunRequest` carries `params` but
**not** the pattern that matched, so the pattern comes from dunx's own `RouteContext`.

## Library decision

| Candidate | Verdict |
| --- | --- |
| `node:perf_hooks` histogram, `monitorEventLoopDelay`, `server.pendingRequests` | **Use all three.** Bun-native; 10.7 ns at 0.01% error, no loop hold, 14.65 ns. |
| `hdr-histogram-js` 3.0.1 | **No.** 0.68 MB unpacked, and its 3 dependencies include `pako`, a JavaScript zlib reimplementation Rule 1 bans. WASM, not N-API, for an algorithm already compiled into the runtime. |
| `prom-client` 15.1.3 / `@opentelemetry/api` + `sdk-metrics` | **No dependency on either:** a recipe for prom-client, naming conventions from OTel. Hand-rolled bucket counters lose too, at 25.5 vs 10.8 ns and bucket edges instead of percentiles. |

**prom-client owns exposition and is not a dunx dependency.** `bun pm view prom-client` gives
15.1.3, Apache-2.0, 126.44 KB unpacked, 2 dependencies (`@opentelemetry/api`, `tdigest`). Pure
JS, runs under Bun. Measured: `Counter.inc` **377.3 ns**, `Histogram.observe` **655.9 ns**,
`Gauge.inc`+`dec` 107.3 ns, `registry.metrics()` 2782.6 us - its histogram is **61x** the
native `record()`, the wrong thing on a request path. Its `collectDefaultMetrics` is also
**partly dead on Bun**, which decides what dunx contributes:

```
$ bun probes/stats/prom2.ts   # after 950ms warmup and a 150ms block
nodejs_eventloop_lag_seconds 0            <- always 0, prom-client's own probe
nodejs_active_resources_total/handles/requests 0  <- no getActiveResourcesInfo on Bun
nodejs_gc_duration_seconds                <- header lines, zero samples
process_virtual_memory_bytes 75687161856  <- 75 GB of reserved address space
```

Scraped before its lag monitor has a sample it emits `nodejs_eventloop_lag_min_seconds
9223372036.854776` and `nodejs_eventloop_lag_mean_seconds Nan` - the empty-histogram sentinels
above, and `Nan` is not a token the Prometheus text format accepts. So dunx neither competes
with prom-client nor wraps it: dunx supplies **the Bun-native numbers prom-client cannot
get**, as a JSON snapshot the consumer feeds into their own registry. That is the drizzle
relationship - the library owns the abstraction, Bun owns the source.

**OpenTelemetry: adopt the names, not the API.** With no SDK registered, `@opentelemetry/api`'s
noop `Counter.add` costs **14.4 ns** and noop `Histogram.record` **18.0 ns**, on par with
`perf_hooks.record` itself, so an app with no collector would pay almost nothing; with the SDK
registered it is 904-932 ns, 65x the noop and 26x the native histogram. It still loses, and not on
cost: instrumenting against `@opentelemetry/api` means dunx picks the metrics API its consumers
must use, and adds a 1.0 MB peer to a framework whose `@dunx/core` has zero dependencies, where
dunx's contract stays library-agnostic if a standard exists. Free and worth taking is OTel's
**semantic conventions for the field names** (`http.route`, `http.request.method`,
`http.response.status_code`, `http.server.request.duration`), so translating the JSON into a
prom-client registry or an OTel meter is mechanical and is not dunx's code.

## Public API

No `Dunx` prefix, no `enum`, no parameter decorators, no `any`. Every injection site is a class.
`Counter` is `inc(by?)` plus a `value` getter and `Gauge` extends it with `set` and `dec`; those
two and `Durations` hold state, so they are classes per Rule 3, and they are not injection sites,
since a consumer gets them from a service the way a consumer gets log entries from `Logger` rather
than injecting one.

```ts
// @dunx/core - src/stats/histogram.ts
/** Nanoseconds. Every field but `count` is optional and absent when count is 0, because
 *  an empty native histogram reports min 9223372036854776000 and mean NaN. */
export interface HistogramSnapshot {
  readonly count: number;
  readonly min?: number; readonly max?: number; readonly p50?: number;
  readonly p90?: number; readonly p95?: number; readonly p99?: number; readonly p999?: number;
}

/** `createHistogram()` with the sharp edges closed: a sub-microsecond observation clamps
 *  to 1 instead of throwing, and an empty histogram serialises without its sentinels. No
 *  options - explicit bounds cost 8-19x the memory and record slower. */
export class Durations {
  record(nanoseconds: number): void; reset(): void; snapshot(): HistogramSnapshot;
}

// src/stats/runtime.ts
/** `RuntimeReport` is `{ pid, uptimeMs, now, bun, platform, arch, memory, cpu, resource,
 *  eventLoopLag? }`: `memory` is rss/heapUsed/heapTotal/external, `cpu` is
 *  `process.cpuUsage()` microseconds, `resource` is `process.resourceUsage()`'s maxRSS, page
 *  faults and context switches, `eventLoopLag` is nanoseconds and absent unless enabled.
 *  9.1 us a snapshot, so a poll-time call and never a per-request one; `startedAt` is a
 *  `performance.now()` mark rather than `process.uptime()`, which counts from interpreter
 *  start - a difference that matters after thirty seconds of migrations. */
export class RuntimeStats {
  constructor(startedAt?: number);
  snapshot(): RuntimeReport;
}

// src/stats/event-loop.ts - EventLoopLagOptions is a class rather than an interface because
// a consumer injects it (Rule 3); its one field is `resolution`, ms, default 20.
/** `monitorEventLoopDelay`, which Bun implements natively. Enabled in `onInit` rather than at
 *  read time: a block in the same turn as `enable()` is not sampled, so a monitor enabled by
 *  the first scrape reports 1.6-7.9 ms for a 300 ms stall. */
export class EventLoopLag implements OnInit, OnShutdown {
  constructor(options?: EventLoopLagOptions);
  onInit(): void; onShutdown(): void; snapshot(): HistogramSnapshot;
}
```

`HttpStatsReport` is `{ routes: readonly RouteStats[], inFlight, pendingWebSockets, since }`, the
two gauges read live off the server at 14.65 ns rather than counted, and `RouteStats` is `{ route,
method, count, byStatus, duration: HistogramSnapshot, slowestRequestId? }` with `duration` in
nanoseconds and `slowestRequestId` the `x-request-id` of the slowest so far.

```ts
// @dunx/http - src/server/metrics.ts
/** One series per route, keyed on the frozen `RouteContext` `buildContext` makes at boot.
 *  That identity is the label set: a `Map<RouteContext, ...>` lookup is 8.8 ns where
 *  building `${method} ${path}` and hashing it is 206.6 ns. Bound by `HttpFactory`'s
 *  global wrapper, like `PubSub` and `ClientAddress`: an unbound class self-binds into
 *  whichever scope asks first, so a second consumer would be a boot error. */
export class RequestMetrics {
  observe(ctx: RouteContext, status: number, durationNs: number, requestId?: string): void;
  snapshot(): HttpStatsReport; reset(): void;
}

/** Installed only when `requestLogging: false`. With logging on - the default -
 *  `RequestLoggingMiddleware` calls `observe` from the `.then` it already allocates,
 *  which is 35.2 ns against this middleware's 175.9 ns. */
export class MetricsMiddleware implements Middleware {
  constructor(private readonly metrics: RequestMetrics) {}
  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response>;
}
```

### Cardinality: the pattern is already on the context

`ctx.path` is the route **pattern**, through five files: `packages/http/src/route/discover.ts:85`
builds it as `joinPath(prefix, resolvePath(meta.path))`; `server/application.ts:420` adds the
global prefix; `server/routes.ts:322` uses it verbatim as the `Bun.serve({ routes })` key, so Bun
matches on it; `server/context.ts:14`, `:25-35` freeze it onto one `RouteContext` per route at
table-build time; `server/middleware.ts:31` hands that same object to every middleware per
request, because `compose` closes over it. Series count is therefore bounded by the handler count,
and `/users/123` and `/users/456` land on the one `/users/:id` series with no normalisation step,
where the middleware's own local `path` (`request-logging.ts:193-194`) is the **concrete** path
the log line wants.

**One trap, and the only cardinality risk here.** `unmatchedContext`
(`server/routes.ts:144-155`) sets `path: new URL(req.url).pathname`, the concrete path,
because a 404's log line should name what missed - so a metric keyed on it grows one series
per probe URL. `observe` collapses every miss into one `(unmatched)` series, discriminated by
the `UNMATCHED` key that context already answers (`routes.ts:151`), which also settles
`routes.ts:159`: "which makes a 404 invisible to request logging, metrics and tracing."

### Correlation with the request context: one of three is worth building

- **Per-request timing spans, and a child-metric namespace per request.** Neither. A span tree
  with parent links, sampling and propagation is distributed tracing, which
  `@opentelemetry/sdk-trace-*` owns (Rule 1's second half); and a metric is an aggregate over
  requests, so one per request is a log line, which dunx already writes exactly one of.
- **A request id on an exemplar.** **Yes, and nearly free.** `RouteStats` carries
  `slowestRequestId`, set on the compare that already updates the max, answering the only
  question a percentile provokes - which request was the p99, and where are its logs - by
  joining onto the `x-request-id` the middleware already stamps on the response
  (`request-logging.ts:392`). The id is a local in that closure, so no store is read.

### Under either async-context outcome

**Nothing above changes.** The route identity arrives as the `ctx` argument to
`Middleware.handle` (`middleware.ts:12`); the duration and requestId are locals in the same
closure. No ambient lookup is on the request path, `observe` takes everything as parameters,
and the 35.2 ns stands either way.

One optional feature differs: a service four frames down timing its own work and having it
attributed to the right route without being handed a registry. **If ambient ALS context
stays,** `stats.time('db.query')` returns a stoppable handle and reads the ambient store for
the current route - one store read, gated on `requestLogging.correlate`, which opens the
scope (`request-logging.ts:215-228`); `AsyncRequestContext.getContext` spreads into a fresh
object (`packages/core/src/logger/context.ts:52-54`), so the timer must not call it per
observation. **If context is threaded explicitly,** the call takes it first,
`stats.time(ctx, 'db.query')`, which a handler already receives. Build this one **after** the
parallel measurement lands.

## Where it lives

No new package. `@dunx/core` for the primitives and the runtime readers, `@dunx/http` for the
request half.

New files under `packages/core/src/stats/`: `histogram.ts` (`Durations`, `HistogramSnapshot`),
`counters.ts` (`Counter`, `Gauge`), `runtime.ts` (`RuntimeStats`, `RuntimeReport`, `MemoryReport`,
`CpuReport`, `ResourceReport`), `event-loop.ts` (`EventLoopLag`, `EventLoopLagOptions`),
`index.ts`, and four `*.test.ts` of which the lag one needs a spawn. Plus
`packages/http/src/server/metrics.ts` (`RequestMetrics`, `MetricsMiddleware`, `RouteStats`,
`HttpStatsReport`) and its test, covering pattern keying, the `(unmatched)` collapse and the
exemplar.

**Declarations that MOVE**, the `providersOf` / `modulesOf` move on the same trigger.
`memory()` at `dashboard/src/api/runtime.ts:63-71` is simply deleted, replaced by
`RuntimeStats.snapshot().memory`.

| Declaration | From | To | Re-exported from |
| --- | --- | --- | --- |
| `MemoryReport` | `dashboard/src/api/types.ts:70-75` | `core/src/stats/runtime.ts` | `api/types.ts` keeps `export type { MemoryReport }`, so `internal/dashboard-ui`'s relative `import type` is unchanged |
| `RuntimeReport` | `dashboard/src/api/types.ts:78-88` | Splits: the process half becomes core's; the dashboard's keeps `probes` and spreads core's into it | `api/types.ts` re-exports core's |

`core/src/index.ts` gains a fourth line, `export * from './stats/index.js'`.

| Edited file | Change |
| --- | --- |
| `http/src/server/factory.ts:72` | `const services = [PubSub, ClientAddress]` becomes `[PubSub, ClientAddress, RequestMetrics]`, inside the `global: true` `HttpModule` wrapper (`:38`, `:75-83`); `HttpOptions` gains `metrics?: boolean`, default `false` |
| `http/src/server/application.ts:317` | `attachServer(this.#app.get(RequestMetrics), this.#server)` beside `attachAddressSource`, mirroring `client-address.ts:46-51` - `server.pendingRequests` is readable only from the bound server |
| `http/src/server/request-logging.ts` | `#succeeded` and `#failed` call `observe(ctx, status, Bun.nanoseconds() - started, requestId)`; three lines |
| `dashboard/src/contracts.ts`, `options.ts`, `api/runtime.ts`, `router.ts:53-62` | `StatsSource` restating `RequestMetrics.snapshot()` structurally; `DashboardOptions.stats?`; `memory()` deleted and `runtimeReport` spreading core's snapshot; one `case 'stats':` in the existing `handleApi` switch |

**Exports-map and manifest changes: none.** `@dunx/core` gets no subpath - the stats classes
join the root export, and core keeps **zero dependencies** because `node:perf_hooks` and
`process` are platform builtins. `@dunx/http` gets no subpath either, and `@dunx/dashboard`'s
manifest is untouched: it has no `dependencies` key and `@dunx/core`/`@dunx/http` are already
non-optional peers (`package.json:69-70`).

**`@dunx/infra` is untouched and gets no `/metrics` subpath.** The request half needs
`RouteContext` and the live `Bun.serve` server, and `@dunx/infra` must not depend on the web
layer, refused for a request logger in `/logger`, for `PubSubRelay`, for `@dunx/auth`'s guard,
and for the Redis websocket adapter. This is the fifth time, and the answer is `PubSubRelay`'s: contract
and implementation both live in `@dunx/http`, which depends only on `@dunx/core`. Queue and
database metrics, if ever wanted, are `@dunx/infra` classes reporting into a `Counter` and a
`Durations` **from core**. The dashboard panel is a **table of routes** reusing
`internal/dashboard-ui/src/format.ts:25`'s `duration()`; no chart.

## What it refuses

- **A Prometheus text writer, and routing through `prom-client`.** It owns exposition and its
  histogram is 61x the native one; dunx serves JSON and documents the pump.
- **A public `/metrics` route.** The JSON sibling sits behind `@dunx/dashboard`'s existing
  `authorize` - no default, 404 rather than 403 - because an unauthenticated endpoint
  enumerating every path and its error rate is reconnaissance.
- **Every millisecond-scale reader** (`generateHeapSnapshot`, `bun:jsc.heapStats()`,
  `node:v8`), **`Bun.unsafe.mimallocDump()`**, **a GC metric**, **`mean`/`stddev`**, **an
  in-flight counter of dunx's own**, **a histogram per (route, status)**, and **tracing,
  spans, or labels by user id, tenant or query string** - each rejected on a number above.
- **Moving `internal/bench`'s histogram into core.** It crosses a Worker boundary as a
  `Uint32Array`, which a native `Histogram` cannot.

## Risks and open spikes

- **`createHistogram` and `monitorEventLoopDelay` are undocumented on Bun's side.** Both work
  and are accurate, but nothing promises they stay. `Durations` is the only file importing
  `createHistogram` and its test asserts all four sharp edges, so a Bun change moves one file
  and one test. The **first-turn blind spot** is measured, not explained; enabling in `onInit`
  makes it irrelevant in practice, guarded by a test asserting a 300 ms block after a 200 ms
  warmup reports >= 250 ms.
- **Histogram memory was measured through RSS**, so the absolute figure carries GC noise
  (11.3 KiB at N=4000, 18.5-23.3 KiB in three other runs); the 8-19x penalty for explicit
  bounds reproduced every run and is the load-bearing part. Re-measure with
  `jsc.estimateShallowMemoryUsageOf` before publishing it.
- **Nothing resets.** A cumulative histogram over a week has a p99 reflecting a deploy three
  days ago, and Prometheus solves this with `rate()` over monotonic counters, so resetting on
  scrape would break the consumer that matters most. Open; the interim answer is `reset()`
  being public with the docs saying who may call it.
- **The in-handler timer waits** on the parallel async-context measurement, the only piece
  gated on it. **No adopter has asked for this**, either: the ROADMAP freeze is the binding
  constraint, and the strongest part of this plan is the part that is not a feature: moving
  `MemoryReport` and the memory reader down into core, which the parallel health module needs whether or not any
  metric ships.

## Cost

**Files:** 8 new (5 source + 4 test in core, 1 source + 1 test in http), 9 edited as tabulated
above; ~420 source and ~380 test lines, all under the 500-line cap - `request-logging.ts` is
already ~440 lines and the metrics call is 3 of them, so check it after editing. **New
dependencies: zero**: `node:perf_hooks` and `process` are platform builtins, so `@dunx/core`
keeps its empty dependency list, and `prom-client` appears in a README code block and in no
manifest.

**Measured per-request overhead**, through the real `@dunx/http` `compose()`:

```
$ bun probes/stats/21-decompose.ts
passthrough: next()                                     0.6052 us (605.2 ns)
+ .then((res) => res)                                   0.7226 us (722.6 ns)
+ two Bun.nanoseconds()                                 0.7458 us (745.8 ns)
+ Map.get + record + status counter                     0.7811 us (781.1 ns)

.then +117.5 ns | two Bun.nanoseconds() +23.2 ns | recording +35.2 ns
TOTAL standalone +175.9 ns | folded into an existing .then +35.2 ns
```

**+35.2 ns per request** in the shipped configuration, because `RequestLoggingMiddleware` already
allocates the `.then` (`request-logging.ts:325`) and already holds `started` (`:201`). Against the
5.38 us request logging costs over `requestLogging: false` that is **0.65%**; with
`requestLogging: false`, `MetricsMiddleware` pays the `.then` itself, **+175.9 ns**. `elapsedMs`
cannot be the shared value: it is `Math.round((Bun.nanoseconds() - started) / 1e6)`
(`request-logging.ts:120-121`), so every sub-millisecond request rounds to 0 and `record(0)`
throws; the raw `started` is shared.

**Read side:** `RuntimeStats.snapshot()` is 7.41 + 1.01 + 0.63 = **~9.1 us**.
`RequestMetrics.snapshot()` over 24 routes and 5 statuses each is **261.5 us**, of which 182.2
us is the 96 `percentile()` calls - 0.002% of a core on a 15-second scrape. Hand-written
Prometheus text over the same data was 271.0 us and the JSON 379.1 us, so refusing exposition
costs nothing. **Memory:** ~16 KiB per route series: ~390 KiB at 24 routes, ~3.2 MiB at 200.

**Docs:** one new guide section with the prom-client recipe; `packages/dashboard/README.md` for
the `stats` option; and `docs/bun-apis.md` for the four `createHistogram` edges, the
`monitorEventLoopDelay` first-turn gap, `mimallocDump`'s fd-2 behaviour, `generateHeapSnapshot`'s
cost, `percentAvailableMemoryInUse()` returning `null`, `totalCompileTime()` returning 0 and the
three `node:v8` results. `docs/architecture/` takes the microsecond decomposition; the guide takes
the 0.65%. **Examples:** `examples/full` adds `metrics: true` and one line printing the snapshot
in its `tour`. **CI:** none beyond the new tests, and the `EventLoopLag` test blocks ~500 ms in a
subprocess.
