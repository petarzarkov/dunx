# Metrics

Counts and timings for requests, database queries, cache reads, Redis commands
and queue jobs, as JSON. There is no Prometheus endpoint and no metrics
dependency. dunx supplies the numbers Bun can measure; exposition belongs to
whatever already scrapes your service.

## Turning it on

Five flags, independent of each other:

```ts
const app = await HttpFactory.create(AppModule, { metrics: true });
```

```ts
DbModule.forRoot(new SqliteOptions({ schema, filename }), { metrics: true });
CacheModule.forRoot({ ttl: 30_000 }, { metrics: true });
RedisModule.forRoot({ url }, undefined, { metrics: true });
QueueModule.forRoot({ url }, { metrics: true });
```

All five default to `false`. With `metrics: false` no driver is wrapped and no
histogram is allocated.

The settings object is always the last parameter, which on `RedisModule` puts it
after the optional connection subclass. `forRootAsync` takes it in the same slot.

## Reading requests

`RequestMetrics` is bound app-wide by `HttpFactory`, so any provider can inject it:

```ts
export class OpsService {
  constructor(private readonly metrics: RequestMetrics) {}

  report(): HttpStatsReport {
    return this.metrics.snapshot();
  }
}
```

```json
{
  "routes": [
    {
      "route": "/users/:id",
      "method": "GET",
      "count": 1841,
      "byStatus": { "200": 1802, "404": 39 },
      "duration": {
        "count": 1841,
        "min": 210000,
        "max": 48100000,
        "p50": 940000,
        "p90": 2100000,
        "p95": 3400000,
        "p99": 12800000,
        "p999": 47900000
      },
      "slowestTraceId": "4bf92f3577b34da6a3ce929d0e0e4736"
    }
  ],
  "inFlight": 3,
  "pendingWebSockets": 12,
  "since": "2026-09-02T09:14:22.881Z"
}
```

Durations are **nanoseconds**. `inFlight` and `pendingWebSockets` are read off the
live `Bun.serve` server at 14.7 ns rather than counted.

### One series per route pattern

`/users/1` and `/users/2` are counted in one `/users/:id` series. The pattern is
fixed when the route table is built at boot, so nothing is normalised per request
and there is at most one series per handler.

Every path that matched nothing collapses into a single `(unmatched)` series per
method. A 404's log line still names the concrete path it missed.

A path that a middleware **claims** gets its own series, even though it matched
no route. For example, each RPC behind `@dunx/http/connect` gets its own row.
Claimed paths are fixed at boot, so the number of series stays bounded.

An `ignore`d or `ignorePrefix`ed path **is** counted. That option is about log
volume, and a health check polled every second is the clearest case of something
worth a metric and not worth an entry.

### `slowestTraceId`

The trace of the slowest request seen on that route. Every line that request
wrote carries the same `traceId`, so one search finds the logs behind the p99.

It is absent when `requestLogging: { trace: false }` turned tracing off. Under
[Tracing](./31-tracing.md) with a recording SDK it is the exported span's trace.

## Reading queries

`QueryMetrics` is exported by `DbModule` when `metrics: true`:

```json
{
  "operations": [
    {
      "operation": "select",
      "count": 4210,
      "errors": 0,
      "duration": { "count": 4210, "min": 8000, "p99": 1400000 },
      "slowest": "select \"id\", \"name\" from \"users\" where \"users\".\"id\" = $1"
    }
  ],
  "total": 4380,
  "since": "2026-09-02T09:14:22.881Z"
}
```

Queries are grouped by leading keyword: `select`, `insert`, `update`, `delete`,
`other`. A statement starting with `with` is `other`, since a CTE can end in any of
the four.

Timing happens at the driver dunx constructs. Drizzle's `logger` option cannot
supply it: `logQuery` fires immediately before a statement runs and has no
completion callback.

With `bun:sqlite`, dunx times the prepared statement's execute methods, which are
synchronous. With `Bun.SQL`, it times the query's `then`, so a query still does not
run until it is awaited.

`errors` counts statements that threw or whose promise rejected. They stay in
`count` as well.

### `slowest` is a shape, not a query

Literals are replaced before the text is stored: `where email = 'ada@example.com'`
is kept as `where email = '?'`. The snapshot is served over the dashboard's stats
endpoint, so anything retained is readable by whoever can reach that page.

Queries built with drizzle already use parameters, so they contain no values.
Redaction matters for `sql` templates and hand-written statements. It runs before
the text is truncated, so a long literal is never left half in the snapshot.

## Reading the cache

`CacheMetrics` is exported by `CacheModule` when `metrics: true`:

```json
{
  "operations": [
    {
      "operation": "get",
      "count": 18421,
      "errors": 2,
      "duration": { "count": 18421, "min": 900, "p99": 72000 }
    },
    {
      "operation": "set",
      "count": 4210,
      "errors": 0,
      "duration": { "count": 4210, "p99": 140000 }
    },
    {
      "operation": "del",
      "count": 103,
      "errors": 0,
      "duration": { "count": 103, "p99": 96000 }
    }
  ],
  "hits": 17632,
  "misses": 787,
  "hitRate": 0.9573,
  "total": 22734,
  "errors": 2,
  "since": "2026-09-02T09:14:22.881Z"
}
```

Three operations - `get`, `set`, `del` - always in that order, and only the ones
that have run. `hitRate` is `hits / (hits + misses)`, and `0` before the first
read.

A `get` that threw counts in `errors` and is left out of `hitRate`. An unreachable
L2 therefore shows up as errors, not as misses.

### The seam is the store, not `Cache`

`CacheModule` wraps the configured `CacheStore` in a `MeteredCacheStore`. Code
that injects the store directly is counted too. `wrap` counts only the reads that
reach the store, so five concurrent `wrap('k', load)` calls are one miss and one
write.

With a `TieredCacheStore`, each call counts once. An L2 hit promoted into L1 is one
`get` and one hit, and the promotion is not counted as a `set`. To count one tier
separately, wrap it with its own `CacheMetrics`:

```ts
const l1Stats = new CacheMetrics();
const store = new TieredCacheStore(
  new MeteredCacheStore(new MemoryCacheStore(), l1Stats),
  new RedisCacheStore(redis),
);
```

An expired entry is a miss: it is what the read answered.

Turning metrics on **changes what `CacheStore` resolves to**: it is the
`MeteredCacheStore`, not the store that was configured. Code that tests the
configured store reads through `inner`, or stops matching the day the flag goes
on.

```ts
const { store } = options;
const configured = store instanceof MeteredCacheStore ? store.inner : store;
if (configured instanceof TieredCacheStore) {
  // ...
}
```

### The key is never kept

There is no `slowest` field, for the reason `RedisMetrics` has none. A cache key
is application data, and the snapshot is served over the dashboard's stats
endpoint.

There is no caller-chosen label either, so the series count is three and nothing
here is capped.

## Reading Redis commands

`RedisMetrics` is exported by `RedisModule` when `metrics: true`:

```json
{
  "commands": [
    {
      "command": "GET",
      "count": 8412,
      "errors": 3,
      "duration": { "count": 8412, "min": 41000, "p99": 980000 }
    }
  ],
  "total": 12904,
  "errors": 3,
  "since": "2026-09-02T09:14:22.881Z"
}
```

Every method on the connection and every `send()` is counted, with one series per
command. `errors` counts commands that rejected, including the ones Bun throws
synchronously for subscriber-mode and argument errors. Errors are also included in
`count`.

`send('client', ['id'])` records `CLIENT`. The series name is whatever command
string the caller passed, even one the server rejects. So the number of series is
capped, as for queues: 128 commands, then one `(other)` series, 129 in the
payload.

### The key is never kept

There is no `slowest` field. `QueryMetrics` keeps a redacted statement shape for
its slowest query; the same field here would hold a Redis key, which is
application data with no redaction that would make it safe to serve.

### A named connection binds a token

The default connection binds the class:

```ts
constructor(private readonly stats: RedisMetrics) {}
```

A connection registered with a name or a subclass gets its own instance under
`redisMetrics(label)`, where the label is the name or the subclass name. Two
registrations both binding `RedisMetrics` would leave the importer resolving one
of them.

```ts
RedisModule.forRootAsync(config, SessionsRedis, { metrics: true });

class Ops {
  readonly sessions = inject(redisMetrics('SessionsRedis'));
}
```

## Reading the queue

`QueueMetrics` is exported by `QueueModule` when `metrics: true`, keyed by queue
and job name:

```json
{
  "jobs": [
    {
      "queue": "thumbnails",
      "name": "render",
      "published": 1204,
      "publishErrors": 0,
      "publishDuration": { "count": 1204, "p99": 3200000 },
      "handled": 0,
      "failed": 0,
      "timedOut": 0,
      "handlerDuration": { "count": 0 }
    }
  ],
  "published": 1204,
  "handled": 0,
  "since": "2026-09-02T09:14:22.881Z"
}
```

`failed` and `timedOut` are disjoint: a handler rejected by `jobTimeoutMs` counts
only in `timedOut`. A job name no handler claims is not recorded at all, since no
handler ran.

### What a forked handler does to these numbers

The publish side is always this container's. The handler side is only this
container's when the handler ran here.

`isolation` defaults to `'process'`, so a `@JobHandler({ background: true })`
runs in a forked child process with its own container. Its durations are not
recorded here. A worker process built by `WorkerFactory` is a separate container
too. A web process that publishes to such a queue shows `handled` at 0 while
`published` climbs, as in the payload above.

A handler without `background` is recorded in the `handlerDuration` of the
container that consumed the job: the one given `consume: true`, the one passed to
`WorkerFactory.attach()`, or the worker process `WorkerFactory.create` booted. Each
has its own `QueueMetrics`.

### Series are capped at 128, so a payload holds at most 129

`publish(queue, name, data)` takes the job name from the caller. A name built from
data would keep two histograms per distinct value for the life of the process, so
after 128 distinct queue and name pairs, the rest go into one `(other)/(other)`
series. That series is an extra entry, so `jobs` then has 129 entries.

Only `publish()` is counted. `queue(name)` hands back bullmq's own `Queue`, and
`add`, `addBulk` and `upsertJobScheduler` on it go round the seam.

## On the dashboard

Pass any of the three sources to `DashboardModule` and the Stats panel renders
what it was given:

```ts
DashboardModule.forRootAsync({
  imports: [DatabaseModule, CacheModule],
  useFactory: (
    stats: RequestMetrics,
    dbStats: QueryMetrics,
    cacheStats: CacheMetrics,
  ) => ({
    path: '/api/_dunx',
    authorize,
    stats,
    dbStats,
    cacheStats,
  }),
  inject: [RequestMetrics, QueryMetrics, CacheMetrics] as const,
});
```

A source left out shows as a panel saying so rather than an empty table.

The JSON sibling is `GET {path}/api/stats`, behind the same `authorize` as every
other panel. An unauthenticated endpoint listing every route and its error rate is
reconnaissance, so there is no public `/metrics`.

The Stats panel is visible at
[demo.dunx.win/api/dashboard](https://demo.dunx.win/api/dashboard), a demo that
mounts the page with no `authorize` and a read-only board.

## What it costs

**+35.2 ns per request** with the default configuration, because the recording
reuses the timing `RequestLoggingMiddleware` already does. Request logging itself
costs 5.38 µs over `requestLogging: false`, so metrics add 0.65% to that.

With `requestLogging: false`, a `MetricsMiddleware` is installed instead and pays
for its own `.then`: **+175.9 ns**.

Memory is about 16 KiB per route series: ~390 KiB at 24 routes, ~3.2 MiB at 200.

Reading is a poll-time cost, not a request-time one. `snapshot()` over 24 routes
and five statuses each is 261.5 µs, of which 182.2 µs is the 96 percentile reads.

## Feeding Prometheus

dunx does not output the Prometheus text format. It records with Bun's built-in
`node:perf_hooks.createHistogram`, at 11.1 ns per value. `prom-client` records at
655.9 ns and handles the output format, including bucket ordering, `+Inf`, label
quoting and content-type negotiation.

Pump the snapshot into your own registry:

```ts
import { Gauge, Registry } from 'prom-client';

const registry = new Registry();
const p99 = new Gauge({
  name: 'http_server_request_duration_p99_seconds',
  help: 'p99 request duration',
  labelNames: ['http_route', 'http_request_method'],
  registers: [registry],
});

@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: RequestMetrics) {}

  @Get('/')
  async scrape(): Promise<Response> {
    for (const route of this.metrics.snapshot().routes) {
      p99.set(
        { http_route: route.route, http_request_method: route.method },
        (route.duration.p99 ?? 0) / 1e9,
      );
    }
    return new Response(await registry.metrics(), {
      headers: { 'content-type': registry.contentType },
    });
  }
}
```

The label names above are OpenTelemetry's semantic conventions, which dunx follows
for naming and does not depend on.

## Process and event-loop readers

`@dunx/core` exports the same primitives the request half is built on, for
anything else worth counting.

```ts
import {
  Counter,
  Durations,
  EventLoopLag,
  Gauge,
  RuntimeStats,
} from '@dunx/core';
```

`RuntimeStats.snapshot()` returns pid, uptime, memory, CPU and resource usage in
one object, at about 14 µs. `uptimeMs` counts from construction rather than from
`process.uptime()`, which counts from interpreter start.

`Durations` is a recording histogram with the native one's four sharp edges closed:
an observation below 1 ns clamps instead of throwing, and an empty histogram
reports `{ count: 0 }` instead of a `min` of 9223372036854776000 and a `mean` of
`NaN`.

`EventLoopLag` wraps `monitorEventLoopDelay` and enables it in `onInit`. A block
in the same event-loop turn as `enable()` is not sampled, so a monitor first
enabled by a scrape reports 1.6-7.9 ms for a 300 ms stall.

```ts
@Module({ providers: [EventLoopLag] })
export class OpsModule {}
```

There is no garbage-collection metric. `PerformanceObserver.supportedEntryTypes`
is `["mark", "measure", "resource"]` under Bun, and a `gc` observer never fires.

## Resetting

`reset()` on any of the five classes drops every series and moves `since` forward.
Nothing calls it for you. A cumulative histogram is what `rate()` in a scraper wants, and
resetting on scrape would break the consumer most likely to be reading.
