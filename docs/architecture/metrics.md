# Metrics

The plan and every number behind it are in `internal/notes/research/stats.md`. This
records what changed when it was built, and it is all of what changed.

## Where the design held

Every measurement in the note reproduced on Bun 1.4.0. `record()` is 11.1 ns, all
four native histogram edges still bite, `monitorEventLoopDelay` still misses a
block in the same turn as `enable()`, and `server.pendingRequests` still reads
faster than counting. `Durations` is the only file importing `createHistogram`, so
a Bun change moves one file and one test.

`prom-client` is in a README code block and in no manifest. `@opentelemetry/api` is
a `devDependency` of `@dunx/http` for one interop test and reaches no published
manifest. The naming follows OTel's semantic conventions and depends on neither.

## Three corrections to the note

**`percentiles` does not throw.** It is a `Map`, so `JSON.stringify` returns `{}`
with no error. Extracting a `bigint` value and stringifying that throws. Silent
loss rather than a loud failure, which is worse, and `percentile(n)` returning a
`number` is the answer either way.

**The exemplar is `slowestTraceId`.** The note named it for a correlation id that
no longer exists; W3C Trace Context is the only one, and the record is in
[cost-of-logging.md](./cost-of-logging.md).

**Keying misses on the route context does not work.** The note says `observe`
collapses every miss into one `(unmatched)` series discriminated by the `UNMATCHED`
key. Right about the discriminant, wrong about the key: `unmatchedContext` builds a
**fresh** context object per request, so a `Map<RouteContext, Series>` neither
collapses them nor stays bounded.

A scanner walking urls adds an entry and a ~16 KiB histogram per probe, for as long
as it runs. Misses go in a second `Map` keyed by method, which is bounded. Matched
routes still hit the identity map first and never pay for the `UNMATCHED` read.

## Database timing, which the note deferred

The note left the in-handler timer to a later round and said queue and database
metrics would be "`@dunx/infra` classes reporting into a `Counter` and a
`Durations` from core". That is what `QueryMetrics` is. What the note did not
anticipate is that **drizzle offers no seam that can time a query**:

- `Logger.logQuery(sql, params)` fires immediately before the statement runs and
  has no completion callback. It can count and cannot time.
- drizzle 0.45.2's own OpenTelemetry hook is dead code. `tracing.js` declares
  `let otel;` and never assigns it, so `startActiveSpan` always falls through to
  `fn()` and no span is emitted with an SDK registered.

So the timer wraps the driver dunx itself constructs and hands to `drizzle()`,
which is public Bun API rather than a drizzle internal. Wrapping drizzle's
`session.prepareQuery` was tried first and works; it was dropped because it reaches
into an object drizzle does not export.

The two backends need different wraps, and the `Bun.SQL` one is the interesting
half. `client.unsafe()` returns a lazy `Query` that runs when it is awaited, so
attaching `.finally()` to time it **starts the query**. `then` is wrapped instead,
and the first `then` is the moment execution begins. Verified against Postgres 16;
both behaviours are in [bun-apis.md](../bun-apis.md).

`instrument()` mutates the client in place, and drizzle looks `prepare`/`unsafe` up
per query, so instrumenting after `open()` works. That keeps this out of both
connection constructors and both option classes.

## Re-measured: the cost case against OpenTelemetry has collapsed, and the answer held anyway

The note rejected `@opentelemetry/api` partly on cost, at noop 14.4-18.0 ns and
904-932 ns with an SDK registered. Those are Bun 1.3.14 figures and they are
stale. Re-measured on 1.4.0, 200k iterations warmed, against the attributes dunx
would actually pass:

| Call                                       |    ns |
| ------------------------------------------ | ----: |
| `perf_hooks` `record()`, what dunx uses    |  10.1 |
| OTel noop `histogram.record`               |   3.8 |
| OTel noop, with a route attributes object  |   5.9 |
| OTel + SDK `histogram.record`              |  78.3 |
| OTel + SDK, with a route attributes object | 359.0 |
| `prom-client` `observe` with labels        | 430.8 |

So an app registering no SDK would pay **less** than the native histogram, and one
registering an SDK pays 359 ns, which is 6.6% of the 5.4 us request logging
already spends. Cost is no longer an argument in either direction.

**The answer is still no dependency**, on three reasons that never were about
speed:

- **OTel's metrics API is write-only.** A `Histogram` cannot be asked for its
  p99. The dashboard's Stats panel reads `snapshot()`, so recording into OTel
  instead of aggregating here would mean attaching a `MetricReader` and reading
  the collected batch back - more machinery than `Durations` is.
- **The instrumentation is dunx's either way.** No SDK sees `Bun.serve`,
  `Bun.SQL`, `Bun.RedisClient` or `fetch` (measured, in bun-apis.md), and the
  route _pattern_ comes from dunx's own `RouteContext`. Only the aggregation was
  ever in question.
- **`RuntimeStats` and `EventLoopLag` have no working equivalent.**
  `prom-client`'s `collectDefaultMetrics` is partly dead on Bun: event-loop lag
  always 0, no active-resource counts, zero GC samples.

Plus `@dunx/core` has zero dependencies, and the guide's `prom-client` recipe is
about fifteen lines.

**What would change it:** an adopter wanting OTLP export without writing that
pump. The shape is settled if it ever comes - `@opentelemetry/api` as an optional
peer, `RequestMetrics` and `QueryMetrics` recording into instruments named by the
semantic conventions they already follow, alongside the native aggregation rather
than instead of it. Do not reopen this on the cost figures alone; the numbers
above are the current ones and they did not decide it.

## What is still not built

The ambient `stats.time('db.query')` handle, which the note gates on nothing now
that the drizzle seam covers queries. No adopter has asked for one for cache or
upstream calls, and `HttpService` already logs a line per outbound call.

Nothing resets on scrape, for the reason the note gives: `rate()` over a cumulative
histogram is what a scraper wants. `reset()` is public and the guide says who may
call it.
