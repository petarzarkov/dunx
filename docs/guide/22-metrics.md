# Metrics

Counts and timings for requests and database queries, as JSON. There is no
Prometheus endpoint and no metrics dependency. dunx supplies the numbers Bun can
measure; exposition belongs to whatever already scrapes your service.

## Turning it on

Two flags, independent of each other:

```ts
const app = await HttpFactory.create(AppModule, { metrics: true });
```

```ts
DbModule.forRoot(new SqliteOptions({ schema, filename }), { metrics: true });
```

Both default to `false`. With `metrics: false` no driver is wrapped and no
histogram is allocated.

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

`/users/1` and `/users/2` land on the one `/users/:id` series. The key is the
route context dunx freezes when it builds the table, so there is no normalisation
step and the series count is bounded by the handler count.

Every path that matched nothing collapses into a single `(unmatched)` series per
method. A 404's log line still names the concrete path it missed.

### `slowestTraceId`

The trace of the slowest request seen on that route. Every line that request
wrote carries the same `traceId`, so one search finds the logs behind the p99.

It is absent when `requestLogging: { trace: false }` turned tracing off.

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
      "slowest": "select \"id\", \"name\" from \"users\" where \"users\".\"id\" = ?"
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

For `bun:sqlite` the prepared statement's execute methods are wrapped, which is
exact because they are synchronous. For `Bun.SQL` the lazy `Query`'s `then` is
wrapped, so the measurement covers execution without starting it early.

`errors` counts statements that threw or whose promise rejected. They stay in
`count` as well.

## On the dashboard

Pass either source to `DashboardModule` and the Stats panel renders it:

```ts
DashboardModule.forRootAsync({
  imports: [DatabaseModule],
  useFactory: (stats: RequestMetrics, dbStats: QueryMetrics) => ({
    path: '/api/_dunx',
    authorize,
    stats,
    dbStats,
  }),
  inject: [RequestMetrics, QueryMetrics] as const,
});
```

The JSON sibling is `GET {path}/api/stats`, behind the same `authorize` as every
other panel. An unauthenticated endpoint listing every route and its error rate is
reconnaissance, so there is no public `/metrics`.

## What it costs

**+35.2 ns per request** in the shipped configuration. `RequestLoggingMiddleware`
already allocates a `.then` and already holds the start mark, so the observation
folds into both. Against the 5.38 µs request logging costs over
`requestLogging: false`, that is 0.65%.

With `requestLogging: false`, a `MetricsMiddleware` is installed instead and pays
for its own `.then`: **+175.9 ns**.

Memory is about 16 KiB per route series: ~390 KiB at 24 routes, ~3.2 MiB at 200.

Reading is a poll-time cost, not a request-time one. `snapshot()` over 24 routes
and five statuses each is 261.5 µs, of which 182.2 µs is the 96 percentile reads.

## Feeding Prometheus

dunx writes no Prometheus text. Its histogram is
`node:perf_hooks.createHistogram`, compiled into Bun, recording at 11.1 ns.
`prom-client`'s observes at 655.9 ns and owns exposition, including bucket
ordering, `+Inf`, label quoting and content-type negotiation.

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

`reset()` on either class drops every series and moves `since` forward. Nothing
calls it for you. A cumulative histogram is what `rate()` in a scraper wants, and
resetting on scrape would break the consumer most likely to be reading.
