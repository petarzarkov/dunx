# The benchmark harness

How subjects are made comparable, what the harness refuses to do, and why a result that cannot embarrass us is not a measurement.

## Benchmark harness (`internal/bench`)

Full methodology, subject list and results table:
[`internal/bench/README.md`](../../internal/bench/README.md). Recorded here are the decisions
and the measurements behind them.

**The first thing the harness found was a regression dunx had shipped to itself.**
`@dunx/http` had just made `RequestLoggingMiddleware` a default, and the bench
subject predated it, so the suite was quietly measuring the logger. dunx fell from
~86-94% of raw `Bun.serve` to **34% on `json`, 33% on `params` and 9.6% on
`validate`** - 8.5k req/s against 88k, a p50 of 7.4 ms. Setting
`requestLogging: false` restored ~89%, which located the fault precisely.

Three causes, in order of cost:

- **`response.clone().text()` on every JSON response**, and `req.clone().text()` on
  every JSON request body. Two clone-and-buffer passes over every payload, on the
  hot path, to fill fields most responses never need read. Both are now **off by
  default**, correct for privacy and log volume independently of
  speed, since the response body is also the field most likely to carry a secret.
- **`new URL(req.url)` per request**, parsing scheme, host, port, query and hash to
  reach a pathname. Replaced with an `indexOf` slice; the query string is parsed
  only when there is one.
- What remains is `JSON.stringify` plus a `write` per line, the irreducible
  price of logging and is why `dunx-logging` is its own subject rather than folded
  into the framework's number.

**The rest of the gap to Elysia was async machinery on values that were never
promises.** The general request path is
`async (req) => toResponse(await handler(await read(req)), status)` wrapped in an
`async` try/catch. For a route with no middleware, no CORS and no declared schemas,
`read` is the identity reader and a sync handler returns a plain object - so both
`await`s cost an async frame and a microtask tick for nothing, twice per request.

`buildRoutes` now emits a **synchronous handler** for exactly that shape, returning a
`Response` rather than a `Promise<Response>` (Bun accepts either). A handler that
does return a promise is adopted instead of awaited by a wrapper. Measured on
`plaintext`: **89.5% -> 97.2%** of raw `Bun.serve`, which puts dunx within 0.8
points of Elysia there and within 1.5 points on every scenario. Elysia's advantage was that it
compiles this shape ahead of time; this reaches most of the same place without a
code generator.

The lesson worth keeping: a default that is convenient in development can be the
single largest cost in production, and nobody would have known without a harness
that compares against the floor. `Bun.serve` as a subject is what made the
regression legible - a 9.6% row is impossible to rationalise.

**The load generator is native, and that was measured rather than assumed.**
The harness supports two: [oha](https://github.com/hatoo/oha) (Rust, via `bun
run setup`) and a fallback driver written on Bun's `fetch` across worker
threads. Against the same raw `Bun.serve` process at 64 connections, oha
extracts **135k req/s** and the JavaScript driver plateaus at **80k**,
collapsing to **23k** at 256 connections as thirty worker threads contend on
Bun's connection pool. The JS driver would have understated every Bun subject
by roughly 40% and compressed the whole ranking.

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
understates Fastify and Elysia, and the JSON report records each subject's validator
so the handicap is visible rather than implied.

**Latency histograms in place of reservoir sampling.** The fallback driver buckets latencies
at 1 µs up to 100 ms and merges `Uint32Array`s across workers. The alternative -
sampling a subset - needs an RNG, and a sampled p99 is a p99 with an error bar nobody
reads. It also keeps `Math.random` out of a number that matters, per the `@arkv/rng`
rule.

What the harness found, in one line each:

From `results/latest.json`, Bun 1.4.0, 2026-08-22, **17 subjects measured
interleaved**. Read a ratio as plus or minus one point: two full runs of the same code
disagreed by a median of 0.6 percentage points, which is the harness's measured
reproducibility since interleaving landed (`internal/bench/README.md`, "Interleaving,
and the drift it removes").

- `@dunx/http` costs **0.7% / 3.5% / 6.1% / 7.0%** against raw `Bun.serve` across
  plaintext, json, params and validate. **Under 10% on all four, and inside a point
  of the ceiling on plain dispatch.**
- It is **level with Elysia**, not ahead of it and not behind: 99.3 against 99.1,
  96.5 against 95.6, 93.9 against 97.2, 93.0 against 88.0. Three of those four are
  inside three points. The earlier claim that dunx lost on all four does not
  reproduce, and neither does a claim that it wins.
- The **`params` gap is closed, and it was never what an older bullet here said.**
  That bullet read "85.8% vs 95.5% of baseline" and named it the clearest
  optimisation target; neither number matches any committed run. Elysia's
  ahead-of-time handler compilation is a real difference in approach and the harness
  has never priced it above the noise.
- It **boots in 39.6 ms against raw `Bun.serve`'s 18.6 ms** - the compiler's oxc
  parse plus eager DI resolution and route discovery. Both roughly halved on Bun 1.4,
  which cut Bun's own startup: the same pair was 54.8 ms and 28.7 ms on 1.3.14, while
  every Node subject stayed within 1%. The trade is unchanged and is paid once at
  boot, never per request; it is still a real cost on a short-lived process.
- **Bun is worth ~3.3x on its own.** The same Hono app scores 124,947 req/s on
  `Bun.serve` and 38,167 on `node:http`, a larger gap than any two frameworks on the
  same runtime.
- **Two rows do not add up and should not be quoted yet.** Gin sits at ~56% of
  `bun-serve` and Axum at ~92%, flat across all four scenarios, and two
  single-threaded compiled subjects 1.7x apart on plain dispatch is not a framework
  result. Both are stable to within 2 points across runs, so it reproduces rather
  than being noise. Per this page's own falsification rule, the first suspect is the
  harness - most likely how `GOMAXPROCS(1)` handicaps the Go subjects - and not Go.

**The measurement protocol changed with this run**, so it is not comparable with
anything earlier here.

Subjects used to be measured one at a time to completion. That spread a run over tens
of minutes and mapped the machine's own drift onto subject identity: `bun-serve` was
measured first and `django` forty minutes later, with their ratio published as if the
two numbers were simultaneous.

Measured: two sequential runs of identical code disagreed by a median of 3.9%, with 15
of 20 cells moving the same direction. Rounds are now interleaved across every
subject, which took that to 1.2% with no directional bias. The startup column is
unaffected, since it was never interleaved.

## The cross-language subjects, and how to read them

Gin, raw `net/http`, Axum, Spring Boot and Django are in the suite, and
`results/latest.json` is a full 16-subject run with every toolchain present.
Plaintext and validate are median req/s, deviations under 3% except where noted,
**zero errors on every subject in every scenario**:

| subject           | runtime | plaintext | validate |    startup |
| ----------------- | ------- | --------: | -------: | ---------: |
| `@dunx/http`      | Bun     |   137,539 |   75,769 |    54.8 ms |
| `Bun.serve` (raw) | Bun     |   136,940 |   89,047 |    28.7 ms |
| Elysia            | Bun     |   135,907 |   74,858 |    58.1 ms |
| **Axum**          | Rust    |   118,999 | _83,333_ | **1.5 ms** |
| **net/http**      | Go      |    75,510 |   46,748 |     3.9 ms |
| **Gin**           | Go      |    71,274 |   47,553 |     4.9 ms |
| **Spring Boot**   | JVM     |    46,956 |   31,394 | 1,276.5 ms |
| **Django**        | Python  |     4,387 |    3,882 |   134.2 ms |

These rows exist to be read that way.

**`@dunx/http` came out 0.4% above raw `Bun.serve` on plaintext.** That is not a
framework beating the API it calls; it is noise, at deviations of 1.6% and 1.4%. The
harness has called "a figure at or above 100%" noise since before these
subjects existed, and this is that rule earning its place.

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

**Django's `validate` deviation is 15.7%**, above the 3% noise floor, so that one
figure should not be quoted as precise. Django is on gunicorn with one worker:
`wsgiref` measured 317 req/s with 32 dropped connections, which would have been a
number about `wsgiref` rather than about Django.
