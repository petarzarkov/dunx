# The benchmark harness

How subjects are made comparable, what the harness refuses to do, and why a result that cannot embarrass us is not a measurement.

## Benchmark harness (`internal/bench`)

Full methodology, subject list and results table:
[`internal/bench/README.md`](../../internal/bench/README.md). Recorded here are the decisions
and the measurements behind them.

**The first thing the harness found was a regression dunx had shipped to itself.**
`@dunx/http` had just made `RequestLoggingMiddleware` a default, and the bench
subject predated it. The suite was quietly measuring the logger instead.

dunx fell from ~86-94% of raw `Bun.serve` to **34% on `json`, 33% on `params` and
9.6% on `validate`** - 8.5k req/s against 88k, a p50 of 7.4 ms. Setting
`requestLogging: false` restored ~89%, which located the fault precisely.

Three causes, in order of cost:

- **`response.clone().text()` on every JSON response**, and `req.clone().text()` on
  every JSON request body. Two clone-and-buffer passes over every payload, on the
  hot path, to fill fields most responses never read. Both are now **off by
  default**. That is correct for privacy and log volume independently of speed:
  the response body is also the field most likely to carry a secret.
- **`new URL(req.url)` per request**, parsing scheme, host, port, query and hash to
  reach a pathname. Replaced with an `indexOf` slice; the query string is parsed
  only when there is one.
- What remains is `JSON.stringify` plus a `write` per line: the irreducible price
  of logging. `dunx-logging` is measured as its own subject for that reason,
  rather than folded into the framework's number.

**The rest of the gap to Elysia was async machinery on values that were never
promises.** The general request path is
`async (req) => toResponse(await handler(await read(req)), status)` wrapped in an
`async` try/catch.

For a route with no middleware, no CORS and no declared schemas, `read` is the
identity reader, and a sync handler returns a plain object. Both `await`s cost an
async frame and a microtask tick for nothing, twice per request.

`buildRoutes` now emits a **synchronous handler** for exactly that shape, returning
a `Response` rather than a `Promise<Response>` (Bun accepts either). A handler that
does return a promise is adopted instead of awaited by a wrapper.

Measured on `plaintext`: **89.5% -> 97.2%** of raw `Bun.serve`, which puts dunx
within 0.8 points of Elysia there and within 1.5 points on every scenario. Elysia's
advantage was compiling this shape ahead of time; this reaches most of the same
place without a code generator.

The lesson worth keeping: a default that is convenient in development can be the
single largest cost in production, and nobody would have known without a harness
that compares against the floor. `Bun.serve` as a subject made the regression
legible - a 9.6% row is impossible to rationalise.

**The load generator is native, and that was measured rather than assumed.**
The harness supports two: [oha](https://github.com/hatoo/oha) (Rust, via `bun
run setup`) and a fallback driver written on Bun's `fetch` across worker threads.

Against the same raw `Bun.serve` process at 64 connections, oha extracts **135k
req/s** and the JavaScript driver plateaus at **80k**, collapsing to **23k** at 256
connections as thirty worker threads contend on Bun's connection pool. The JS
driver would have understated every Bun subject by roughly 40% and compressed the
whole ranking.

This is "native over JavaScript reimplementation" holding in a place where it
is easy to check: `oxc-parser` over a JS AST library is the same call.

**oha has headroom over the fastest subject, and that was checked too.** One
`Bun.serve` process driven by one oha gives ~130k req/s; four `Bun.serve` processes
driven by four oha instances give **~385k req/s in total**. A generator with 3x
headroom is not what the numbers are measuring. Without this check the whole table
would be unfalsifiable.

**`bombardier` and `wrk` are unsupported.** Each is one adapter next to
`src/loadgen/oha.ts`, but an untested output parser producing plausible-looking wrong
numbers is worse than an honest "not supported".

**The `Bun.serve` baseline uses route handlers rather than static `Response` objects.**
`Bun.serve({ routes })` accepts a `Response` instance and serves it from a
precomputed buffer, which beats any framework for reasons unrelated to frameworks.
Using it would have inflated the ceiling `@dunx/http` is measured against.

**Every subject validates with the same zod schema**, including Fastify and Elysia,
which ship faster compiled validators. Holding the validator constant is what makes
`validate` minus `json` readable as one framework's validation plumbing. It
understates Fastify and Elysia. The JSON report records each subject's validator,
so the handicap is visible rather than implied.

**Latency histograms in place of reservoir sampling.** The fallback driver buckets
latencies at 1 µs up to 100 ms and merges `Uint32Array`s across workers. The
alternative - sampling a subset - needs an RNG. A sampled p99 is a p99 with an
error bar nobody reads. It also keeps `Math.random` out of a number that matters,
per the `@arkv/rng` rule.

What the harness found, in one line each:

From `results/latest.json`, Bun 1.4.2, 2026-09-09, **20 subjects measured
interleaved**. Every figure is a share of raw `Bun.serve` in the same run, because
the machine moves between runs. Read a ratio as plus or minus one point: two full
runs of the same code disagreed by a median of 0.6 percentage points, which is the
harness's measured reproducibility since interleaving landed
(`internal/bench/README.md`, "Interleaving, and the drift it removes").

- `@dunx/http` costs **0.4% / 4.4% / 5.6% / 7.9%** against raw `Bun.serve` across
  plaintext, json, params and validate. **Under 10% on all four, and inside a point
  of the ceiling on plain dispatch.**
- It is **level with Elysia**, not ahead of it and not behind: 99.6 against 99.0,
  95.6 against 94.3, 94.4 against 99.6, 92.1 against 89.3. Three of those four are
  inside three points. The earlier claim that dunx lost on all four does not
  reproduce, and neither does a claim that it wins.
- The **`params` gap was never what an older bullet here said.** That bullet read
  "85.8% vs 95.5% of baseline" and named it the clearest optimisation target;
  neither number matches any committed run. Elysia's ahead-of-time handler
  compilation is a real difference in approach, and `params` is the one scenario
  where it shows above a point.
- It **boots in 46.2 ms against raw `Bun.serve`'s 24.0 ms**: the compiler's oxc
  parse plus eager DI resolution and route discovery. The same pair was 54.8 ms and
  28.7 ms on Bun 1.3.14. The trade is paid once at boot, never per request; it is
  still a real cost on a short-lived process.
- **Bun is worth ~3.0x on its own.** The same Hono app scores 123,815 req/s on
  `Bun.serve` and 41,201 on `node:http` for plaintext, a larger gap than any two
  frameworks on the same runtime.
- **The Go rows are quotable, with the single-thread handicap stated.** Gin and
  `net/http` sit at 55-58% of `bun-serve` and Axum at 94-98% on the four
  request/response scenarios. **What the Go rows actually measure** below tested the
  `GOMAXPROCS(1)` pin and the garbage collector and eliminated both; the gap is
  per-request work inside `net/http`.

**Interleaving changed the measurement protocol**, so no run before it is
comparable with these.

Subjects used to be measured one at a time to completion. That spread a run over tens
of minutes and mapped the machine's own drift onto subject identity: `bun-serve` was
measured first and `django` forty minutes later, with their ratio published as if the
two numbers were simultaneous.

Measured: two sequential runs of identical code disagreed by a median of 3.9% in raw
req/s, with 15 of 20 cells moving the same direction. Rounds are now interleaved
across every subject, which took that to 1.2% with no directional bias. The 0.6
percentage points quoted above is the same comparison read as a share of
`bun-serve`, the unit every published ratio uses. The startup column is
unaffected, since it was never interleaved.

## The cross-language subjects, and how to read them

Gin, raw `net/http`, Axum, Spring Boot and Django are in the suite, and
`results/latest.json` is a full 20-subject run with every toolchain present.
Plaintext and validate are median req/s, deviations under 3% except where noted,
**zero errors on every subject in every scenario**:

| subject           | runtime | plaintext | validate |    startup |
| ----------------- | ------- | --------: | -------: | ---------: |
| `Bun.serve` (raw) | Bun     |   134,478 |   90,015 |    24.0 ms |
| `@dunx/http`      | Bun     |   133,993 |   82,903 |    46.2 ms |
| Elysia            | Bun     |   133,151 |   80,372 |    51.9 ms |
| **Axum**          | Rust    |   126,969 | _84,320_ | **1.7 ms** |
| **Gin**           | Go      |    76,480 |   50,459 |     5.0 ms |
| **net/http**      | Go      |    74,976 |   49,884 |     4.0 ms |
| **Spring Boot**   | JVM     |    52,073 |   33,944 | 1,322.5 ms |
| **Django**        | Python  |     4,538 |    4,199 |   131.4 ms |

These rows exist to be read that way.

**`@dunx/http` lands at 99.6% of raw `Bun.serve` on plaintext**, and an earlier
run put it 0.4% above. Neither is a framework beating the API it calls; both are
noise, at deviations near 1%. The harness calls "a figure at or above 100%" noise,
and that rule is why the earlier run was not published as a win. Axum's `validate`
figure is italic because its deviation is 4.0%, above the 3% floor.

**Every subject is one process on one thread.** For Bun and Node that is a fact
about the runtime. For Go, tokio and Tomcat it is a decision the harness
imposes - `GOMAXPROCS(1)`, a `current_thread` runtime, `tomcat.threads.max=1`.

Lift it and `net/http` goes to ~230,000 and Axum to ~503,000 at the same 64
connections, while neither Bun subject can move at all. **These rows flatter
Bun by exactly the factor the reader is not shown**, which the bench README
states on the row itself.

If the cross-language rows are ever put on the landing page rather than the
benchmarks page, that caveat has to travel with them - without it the chart
says something about Go and Rust that is not true.

Axum being _ahead_ of dunx on `validate` while behind on plaintext is the honest
shape of it: pinned to one thread, Bun's HTTP core is competitive with tokio at
trivial work and loses once there is real work per request.

Django is on gunicorn with one worker: `wsgiref` measured 317 req/s with 32 dropped
connections, which would have been a number about `wsgiref` rather than about
Django.

### What the Go rows actually measure

The suite's Go subjects sit at 52-56% of `bun-serve` while Axum sits at 90-101%, and
that gap was carried in the roadmap for months as an unexplained anomaly attributed
to Gin. Gin is not the variable, and neither of the two mechanisms tested below is.

**Gin is not the variable.** `nethttp` measures 55-57% in the current run, and Gin
is 101-102% of `nethttp` across all four scenarios, so the framework costs nothing detectable
over the standard library. The comparison the numbers make is the Go runtime against
tokio at one thread.

**The ratio reproduces.** Two full runs on the same machine and the same go1.25.3,
2026-08-26 and 2026-09-03:

| Subject   | plaintext  | json       | params     | validate    |
| --------- | ---------- | ---------- | ---------- | ----------- |
| `nethttp` | 52% -> 54% | 55% -> 56% | 54% -> 55% | 57% -> 53%  |
| `gin`     | 57% -> 56% | 55% -> 56% | 56% -> 54% | 55% -> 54%  |
| `axum`    | 95% -> 92% | 93% -> 93% | 91% -> 90% | 99% -> 101% |

**Two candidate mechanisms were tested and both were eliminated.** Measured outside
the harness against the same binary, `plaintext`, 64 connections, 3 s warmup then
5 s, three pairs:

- **The pin is not pathological.** A build with the `runtime.GOMAXPROCS(1)` line
  removed answers 74,738 req/s at `GOMAXPROCS=1`, matching the pinned binary's
  74,446, then 124,920 at 2 (1.67x), 207,357 at 4 (2.8x) and 315,954 at 8 (4.2x).
  It falls to 179,323 at 32, where the subject oversubscribes a machine it shares
  with the load generator. A pin that scales like that is doing what it says.
- **The garbage collector is not the cost.** `GOGC=off` measured 69,745 / 70,290 /
  69,836 against 74,446 / 74,287 / 74,041 with the default, so disabling collection
  is consistently **slower** - the heap grows and locality gets worse.

What remains is per-request work inside `net/http` - allocation rather than
collection, the header map, and a goroutine per connection - and that has not been
isolated. Doing so needs a profile, not another throughput number.

Two things follow for anyone reading the table. The Go and Rust rows are quotable
with the stated single-thread handicap, since nothing about the handicap is broken.
And "two compiled subjects should land near each other" is the wrong intuition:
compilation is not what predicts per-thread dispatch cost.

Read the ratios rather than the absolute figures. In-harness `nethttp` plaintext
measured 75,510, 60,074 and 70,985 on three runs whose `bun-serve` baselines were
136,940, 115,298 and 131,837 - the whole machine moves between runs, and the
standalone 74k above is not comparable with any of them. The ratio held at 55%, 52%
and 54%.
