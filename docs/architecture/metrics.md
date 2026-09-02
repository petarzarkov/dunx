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

## What is still not built

The ambient `stats.time('db.query')` handle, which the note gates on nothing now
that the drizzle seam covers queries. No adopter has asked for one for cache or
upstream calls, and `HttpService` already logs a line per outbound call.

Nothing resets on scrape, for the reason the note gives: `rate()` over a cumulative
histogram is what a scraper wants. `reset()` is public and the guide says who may
call it.
