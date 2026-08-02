# @dunx/bench

A benchmark harness comparing `@dunx/http` with other backend frameworks and
runtimes. Private workspace, never published.

The point of this harness is not that dunx wins. The single most useful number it
produces is the gap between `@dunx/http` and **raw `Bun.serve`**, because dunx is a
layer on top of that exact API - the gap is dunx's own overhead and nothing else.
Everything below is written so that number, and the places dunx loses, are as hard
to hide as the places it wins.

```bash
bun run setup       # downloads oha into .bin/ (optional, but read "Load generator")
bun run start       # full suite: 15 subjects x 4 scenarios, minus any whose toolchain is absent
bun run validation  # the validation-cost harness - see "Validation cost"
bun run db-modes    # @dunx/infra/db async vs synchronous SQLite, end to end
bun run start --help
```

Three harnesses, and they answer different questions. `start` compares frameworks
with the validator held constant. `validation` does the opposite: one framework at a
time, one step of work at a time, and every validator swapped through the same
Standard Schema seam - which is how the `validate` scenario's cost gets split into
parsing, the validator, and dunx. `db-modes` holds the framework, the SQL and the
bytes on the wire constant and varies only whether the handler awaits its way to the
row; it writes `results/db-modes.json`, and what it found is recorded in
`docs/architecture/constraints.md` under "Synchronous SQLite mode".

## What is measured

Four scenarios, each implemented the same way in every subject:

| Scenario    | Request              | Response                          | What it adds                  |
| ----------- | -------------------- | --------------------------------- | ----------------------------- |
| `plaintext` | `GET /plaintext`     | `Hello, World!` as `text/plain`   | request/response dispatch     |
| `json`      | `GET /json`          | `{"message":"Hello, World!"}`     | + JSON serialisation          |
| `params`    | `GET /params/42`     | `{"id":"42"}`                     | + route matching with a param |
| `validate`  | `POST /validate`     | `{"name":"Ada Lovelace","age":36}` | + body parse and validation  |

Before any scenario is measured, the harness sends one request and asserts the
subject returned **the same status, the same body bytes and the same media type**
as the contract in `src/scenarios.ts`. A subject that answers differently is doing a
different amount of work, and the run fails rather than producing a number nobody
can compare. See `verifySubject` in `src/subject-process.ts`.

Two things are reported per subject and scenario:

- **Throughput** - requests per second, median of N runs, with the standard
  deviation across those runs.
- **Latency** - p50 and p99, medians across runs, as the load generator measured
  them.

And one thing per subject:

- **Startup** - cold process spawn to first served request, median of N samples.
  Polled at 1 ms, so treat anything under about 5 ms as a tie.

### Subjects

| Subject           | Runtime | Why it is here                                                                 |
| ----------------- | ------- | ------------------------------------------------------------------------------ |
| `bun-serve`       | Bun     | The ceiling. `@dunx/http` sits on this API; the gap is dunx overhead.          |
| `dunx`            | Bun     | `@dunx/http`, with the compiler preload and a constructor-injected dependency. |
| `dunx-logging`    | Bun     | The same app with `requestLogging` left at its default - see below.            |
| `elysia`          | Bun     | The other Bun-native framework.                                                |
| `nest-express`    | Node    | **NestJS on its default adapter.** dunx is Nest-shaped, so this is the closest comparison in the suite. |
| `nest-fastify`    | Node    | The same Nest app on the Fastify adapter, isolating adapter from framework.    |
| `hono-bun`        | Bun     | Hono on `Bun.serve`.                                                           |
| `hono-node`       | Node    | The *same* Hono app on `node:http`, so runtime can be separated from framework. |
| `node-http`       | Node    | The Node ceiling: a bare `requestListener`, no framework.                      |
| `fastify`         | Node    | The fast Node framework.                                                       |
| `express`         | Node    | The one everyone actually has in production.                                   |
| `nethttp`         | Go      | The Go ceiling: `net/http` and `http.ServeMux`, no framework.                  |
| `gin`             | Go      | Gin, the Go framework Elysia's landing page compares itself against.           |
| `axum`            | Rust    | Axum on tokio and hyper, no tower layers.                                      |
| `spring`          | JVM     | Spring Boot on its default stack: Spring MVC, Tomcat, Jackson.                 |
| `django`          | Python  | Django on gunicorn with one worker, `DEBUG` off and no middleware.             |

Each subject is a single file under `servers/`, small enough to read in full. If a
number looks wrong, read the file - that is the whole implementation.

The last four need a toolchain this repo does not otherwise use. They are
**opt-in**: `bun run start` probes for each one, and if it is not there it prints a
line saying which subjects it is skipping and produces a report without them, the
same way the Node subjects drop out when `node` does not resolve. Nothing is
downloaded and nothing is installed. See "Requirements".

#### Reading the NestJS rows fairly

dunx borrows Nest's shape - modules, controllers, constructor injection, guards,
decorator-declared routes - so "what does that programming model cost" is the most
useful question this suite can answer. It is also the easiest one to answer
dishonestly, because **Nest runs on Node here and dunx runs on Bun**, and a naive
reading credits dunx with a runtime difference it did not earn.

Three comparisons, in increasing usefulness:

- `dunx` vs `nest-express` mixes framework *and* runtime. Do not quote it alone.
- `nest-express` vs `express`, and `nest-fastify` vs `fastify`: same runtime, same
  server, Nest added. **That gap is Nest's own overhead** - the DI container, the
  interceptor and pipe chain, the metadata reflection.
- `dunx` vs raw `Bun.serve` alongside `nest-express` vs raw `node:http`: each
  framework against its own runtime's ceiling. This is the fair comparison, and it
  is the one to quote.

Nest is also the only subject using **legacy decorators and `reflect-metadata`** -
its programming model requires them. dunx uses TC39 standard decorators and records
constructor types at build time instead, which is where its startup difference
mostly comes from. `servers/nest/` has its own `tsconfig.json` for exactly this and
is excluded from every other project in the repo.

#### Why dunx appears twice

`@dunx/http` installs `RequestLoggingMiddleware` by default: one structured entry
per request. **No other subject in this suite logs anything.** Comparing a
framework that writes and flushes a line per request against seven that write
nothing measures the logger, not the framework - so the primary `dunx` subject
passes `requestLogging: false`, which is the apples-to-apples number.

The cost of the default is not swept under that: `dunx-logging` is the identical
app with the default left alone, in the same table, so both are visible. Read
`dunx` as "the framework" and `dunx-logging` as "the framework plus
out-of-the-box observability".

This split exists because measuring found the default was costing far more than
anyone had guessed - the response-body capture cloned and buffered every payload
on the hot path. That is now off by default, and the remaining gap between the two
rows is `JSON.stringify` plus a `write` per request, which is the irreducible
price of a log line.

#### Reading the Go, Rust and JVM rows fairly

These four exist as a **falsification test on this harness**, not as a
scoreboard. Elysia's landing page shows a JavaScript runtime beating Gin by 3.6x
and Spring by 4.8x, which is not a plausible framework result, and the same
question applies here: if `@dunx/http` comes out ahead of Gin or Axum, the first
conclusion to reach for is that the harness is measuring something other than
what it claims.

Three things make these rows readable, and every one of them is a constraint
that has to be stated with the number:

**Threads.** Every subject in this suite is one process on one thread. Bun and
Node are single-threaded because that is what they are; Go, tokio and Tomcat are
single-threaded here because the harness **made** them, and that is the largest
handicap in the file. `runtime.GOMAXPROCS(1)`, `#[tokio::main(flavor =
"current_thread")]` and `server.tomcat.threads.max=1` are in the three source
files. Without them a 32-core Go server would be measured against a
single-threaded JavaScript one, which ranks the machine and not the framework.
With them, the ranking is per-thread dispatch cost, which is the only thing the
rest of this table has ever measured - and which is **not** what anyone deploying
Go or Rust actually gets. Measured on the machine below: raw `net/http` goes from
about 73k req/s at `GOMAXPROCS(1)` to about 230k with all 32 cores at the same 64
connections, and Axum from about 121k to about 503k. Neither Bun subject can move
at all, because `Bun.serve` is one thread.

**Compilation is not startup.** The Go and Rust binaries and the Spring fat jar
are all built in a prepare pass before anything is measured, and the build time is
reported next to the toolchain rather than inside the startup column. So the
startup column times the same thing for everyone: a cold process answering its
first request. That is honest for Go and Rust, where the compile is genuinely
somebody else's problem at deploy time, and it is honest for the JVM too - class
loading and a JIT-free first request are real costs a JVM pays every boot, and
they stay in the number.

**JIT warmup.** Three seconds does not warm a JVM, so `spring` gets a
30-second unmeasured warmup instead, recorded per subject in the report and
printed above the tables. Reporting a cold JVM would be exactly the kind of
flattering measurement this file exists to avoid, pointed the other way.

**The validator is not held constant across languages.** Inside JavaScript every
subject validates with zod, which is what makes `validate` minus `json` readable.
There is no zod in Go, Rust or Java, so each uses the idiomatic choice -
`go-playground/validator`, the `validator` crate, Hibernate Validator - and each
brings its own email regex. Compare the cross-language `validate` rows to their
own `json` row, not to a JavaScript subject's.

### Deliberate handicaps, in both directions

These are choices that move the numbers. They are listed here rather than buried.

- **`bun-serve` uses route handlers, not static `Response` objects.** `Bun.serve`
  can serve a `Response` instance from a precomputed buffer, which is faster than
  anything a framework can do and measures nothing about frameworks. Using it would
  have inflated the ceiling dunx is measured against - flattering to nobody.
- **Every subject validates with zod**, including Fastify and Elysia, which ship
  faster compiled validators (ajv/JSON Schema and TypeBox). Holding the validator
  constant is what makes `validate` minus `json` readable as *that framework's
  validation plumbing*. It also **understates Fastify and Elysia** on that one
  scenario, and the JSON report records each subject's validator so this is visible.
- **Fastify sets no response schema**, so it serialises with `JSON.stringify` like
  everyone else rather than `fast-json-stringify`. This understates Fastify.
- **Express has `etag` and `x-powered-by` disabled.** Both are on by default and
  are work no other subject does. This flatters Express relative to its defaults.
- **dunx runs with the `@dunx/transform` preload and a real injected dependency**,
  because that is how a dunx app is written. DI resolution happens at boot, so it
  lands in the startup number and not the per-request number.
- **No logging, no CORS, no middleware anywhere.** `@dunx/http` has none of these on
  by default; enabling them for other subjects and not dunx, or vice versa, would
  measure configuration rather than frameworks. `gin.New()` is used rather than
  `gin.Default()` for exactly this reason: `Default` installs a per-request logger
  and a recovery middleware.
- **Rust is built with a plain `cargo build --release`.** No LTO, no
  `codegen-units = 1`, no `panic = "abort"`. Those would be tuning nothing else in
  this suite gets, and they understate Axum by however much they are worth.
- **Axum is given `TCP_NODELAY`.** `axum::serve` leaves Nagle on; Go's `net/http`
  and Bun's uSockets both set it. Measured over six interleaved rounds it makes no
  difference this harness can resolve, but leaving it off would have been a socket
  option masquerading as a framework difference.
- **Spring Boot runs with no JVM flags, no AOT, no CDS and no native image.** That
  understates what a tuned Spring deployment does, and it is what `spring init`
  produces.

## What is not measured

- **Absolute capacity.** The generator and the subject share a machine, a scheduler
  and the loopback interface. These numbers rank subjects against each other on this
  box. They do not predict what any of them does behind a real network.
- **Concurrency beyond one process.** Every subject is single-process and
  single-threaded. No `reusePort`, no cluster, no worker pool. Real deployments scale
  out and the ranking may not survive that. **This is the assumption the
  cross-language rows break**, and it is worth saying plainly: Go, tokio and Tomcat
  all scale across cores in one process and the JavaScript runtimes do not, so a
  per-thread ranking flatters Bun by exactly the factor the reader is not being
  shown. See "Reading the Go, Rust and JVM rows fairly".
- **Anything with I/O.** No database, no cache, no filesystem, no upstream calls. In
  an application that talks to Postgres, all of these differences are rounding error
  next to one query. That is the honest framing for every result below.
- **Memory, and behaviour under sustained load.** Runs are seconds long. Nothing here
  says anything about heap growth or a leak at hour six.
- **TLS, HTTP/2, HTTP/3, websockets, streaming, large bodies, file uploads.**
- **Cold-start under a constrained CPU**, which is what actually matters on a
  serverless platform. The startup numbers here are from an idle 32-core desktop.

## Methodology

0. **Everything is built before anything is measured.** `Bun.build` transpiles the
   Node subjects; `go build`, `cargo build --release` and `mvn package` produce the
   Go, Rust and JVM artifacts. All output lands in `.bench-tmp/` (and the Maven
   repository in `.bin/m2`), both gitignored. A toolchain that does not resolve
   drops its subjects with a note and the run continues. `src/toolchains.ts`.
1. **Node subjects are transpiled first.** `Bun.build` emits ESM to `.bench-tmp/`
   with dependencies external, so Node loads the real express/fastify/hono from
   `node_modules`. This exists because Node's type stripper does not remap the `.js`
   import specifiers this repo requires, and older Node cannot run TypeScript at all.
2. **One fresh process per (subject, scenario).** The harness picks a free port,
   spawns the subject, waits for it to answer, and kills it afterwards. No scenario
   inherits another scenario's warmed-up JIT state or heap.
3. **Contract verification** before every measurement, as described above.
4. **Warmup.** A full unmeasured load run (default 3 s) precedes the measured runs
   for each scenario, so the measured window is against a JIT-warm server. A subject
   may declare a floor it needs regardless of `--warmup`; `spring` declares 30 s,
   because 3 s does not warm a JVM. The floor is in the report and above the table.
5. **Multiple runs.** Default 5 measured runs of 5 s each. The report gives the
   **median** and the **standard deviation** across runs, never a single run.
6. **Startup is measured separately**, by spawning and killing the subject N times
   (default 7) and timing spawn to first successful response. For the compiled
   subjects that is the artifact, never the build - see "Reading the Go, Rust and
   JVM rows fairly".
7. **The machine is recorded** - CPU model, logical cores, RAM, kernel, arch, Bun
   version, Node version - along with every subject's package version, in both the
   stdout table and the JSON.

Defaults: `--connections 64 --duration 5 --warmup 3 --runs 5 --startup-samples 7`.
All are flags; `bun run start --help` lists them.

### Known methodology gaps

- The generator and the subjects are not pinned to disjoint CPU sets. On a 32-core
  box with single-threaded subjects there is enough headroom that this did not show
  up (see below), but on a smaller machine it would.
- Latency is closed-loop and therefore subject to coordinated omission: a stalled
  server also stalls the offered load. p99 here is "p99 of what got sent", not "p99
  a user would see at a fixed arrival rate". oha's `-q` plus `--latency-correction`
  would fix this and is not wired up.
- Run-to-run standard deviation captures variance between runs, not within one.
- Startup polling has ~1 ms granularity.

## Load generator

Two are supported. `--loadgen auto` (the default) picks **oha** if it can find it and
falls back to the JavaScript driver otherwise.

### oha (preferred)

[oha](https://github.com/hatoo/oha) is a Rust/tokio HTTP load generator. `bun run
setup` downloads a prebuilt binary into `.bin/` (gitignored); the harness also picks
up `oha` from `PATH`, or from `$BENCH_OHA`. Adapter: `src/loadgen/oha.ts`.

**It is not the bottleneck**, and that was checked twice rather than assumed.
Driving one `Bun.serve` process at 64 connections gives ~130k req/s. Driving four
`Bun.serve` processes with four oha instances at the same time gives **~385k req/s
in total**.

The second check is the stronger one, and it exists because the first leaves a
hole: four oha instances say nothing about what **one** oha instance at 64
connections can do, which is the configuration every number in this file comes
from. So: the Axum subject was rebuilt on a multi-threaded tokio runtime and
driven by a single oha at the same 64 connections. It answered **~503k req/s**.
The fastest subject in the table is around 130k, so one generator process has
roughly **4x headroom** over it and the top of the table is the server's number,
not the client's. Anyone who suspects otherwise should repeat that check before
believing a ranking near the top - it is the cheapest way to falsify this harness
and it is the one that was tried first.

Limitations: shares the machine with the subject; closed-loop, so latency is subject
to coordinated omission; HTTP/1.1 with keep-alive only, no TLS, no pipelining.

`bombardier` and `wrk` are **not** supported. Adding one is a single adapter next to
`src/loadgen/oha.ts` returning a `LoadSample`, but an untested parser producing
plausible-looking wrong numbers is worse than no support at all.

### The Bun `fetch` driver (fallback)

`src/loadgen/fetch-driver.ts` spreads the requested connections across worker
threads, each running an async `fetch` loop, and merges 1 µs-bucketed latency
histograms back on the main thread. It exists so the harness runs on a machine with
no native generator installed.

**It caps the fastest subjects, and by a lot.** Measured against raw `Bun.serve` on
the machine below:

| Connections | fetch driver | oha       |
| ----------- | ------------ | --------- |
| 32          | ~75k req/s   | ~131k     |
| 64          | ~80k req/s   | ~135k     |
| 256         | ~23k req/s   | ~131k     |

It plateaus around **80k req/s** - roughly 60% of what oha extracts from the same
server - and above about 128 connections it collapses, because thirty JavaScript
worker threads contending on Bun's connection pool cost more than the server does.

So: the fetch driver is usable for a *relative ranking of the slower subjects* and
for smoke-testing the harness. It is not usable for the dunx-vs-`Bun.serve` gap,
which is the number this harness exists to produce. **Install oha for anything you
intend to quote.**

## Cross-language rows are not in the tables below yet

`nethttp`, `gin`, `axum` and `spring` are implemented, pass the contract check and
run, but the published `results/latest.json` predates them. Regenerating it needs
an idle machine, and every table in this file is generated from that one file
rather than typed, so the rows appear the next time a clean full run is taken.
Reproduce them meanwhile with `bun run start --subjects bun-serve,dunx,nethttp,gin,axum,spring`.

What a clean run should be read for, in this order: whether the load generator has
headroom over the fastest row (see "Load generator"), then whether the JavaScript
rows sit above Gin and Axum - and if they do, "Reading the Go, Rust and JVM rows
fairly" is the paragraph that says what that does and does not mean.

## Results

Generated from `results/latest.json` by `bun src/readme-tables.ts` - never
transcribed by hand.

```
AMD Ryzen 9 5950X 16-Core Processor, 32 logical cores, 62.7 GiB RAM
linux 7.0.0-28-generic x64 | bun 1.3.14 | node v20.20.2 | oha oha 1.15.0
64 connections | 3s warmup | 5 x 5s measured | 2026-08-02
dunx-logging 0.0.0 | elysia 1.4.29 | nest-express 11.1.28 | nest-fastify 11.1.28 | hono-bun 4.12.33 | hono-node 4.12.33 | fastify 5.11.0 | express 5.2.1
```

Reproduce with `bun run start`; the full JSON lands in `results/latest.json`.

**Plain text** - `GET /plaintext`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) | 138,507 | 1,950 | 0.435 | 0.875 | 100.0% |
| **@dunx/http** | **135,442** | 1,007 | 0.449 | 0.907 | **97.8%** |
| Elysia | 132,503 | 2,836 | 0.457 | 0.927 | 95.7% |
| Hono (Bun) | 105,194 | 1,424 | 0.579 | 1.160 | 75.9% |
| @dunx/http (+ request logging) | 77,658 | 541 | 0.786 | 1.548 | 56.1% |
| node:http (raw) | 51,481 | 2,531 | 1.169 | 2.313 | 37.2% |
| Fastify (Node) | 48,547 | 204 | 1.288 | 2.519 | 35.1% |
| Hono (Node) | 46,165 | 1,524 | 1.346 | 2.612 | 33.3% |
| NestJS (Fastify) | 38,946 | 459 | 1.604 | 2.001 | 28.1% |
| Express (Node) | 12,484 | 294 | 4.874 | 6.903 | 9.0% |
| NestJS (Express) | 9,918 | 74 | 6.141 | 8.921 | 7.2% |

**JSON** - `GET /json`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) | 130,055 | 3,970 | 0.458 | 0.924 | 100.0% |
| Elysia | 124,264 | 2,972 | 0.481 | 0.972 | 95.5% |
| **@dunx/http** | **123,306** | 1,887 | 0.492 | 0.992 | **94.8%** |
| Hono (Bun) | 92,529 | 916 | 0.660 | 1.320 | 71.1% |
| @dunx/http (+ request logging) | 70,743 | 2,553 | 0.860 | 1.647 | 54.4% |
| node:http (raw) | 50,383 | 623 | 1.238 | 2.458 | 38.7% |
| Fastify (Node) | 45,405 | 1,756 | 1.377 | 2.644 | 34.9% |
| Hono (Node) | 39,978 | 736 | 1.542 | 2.457 | 30.7% |
| NestJS (Fastify) | 37,576 | 313 | 1.674 | 1.932 | 28.9% |
| Express (Node) | 12,640 | 162 | 4.773 | 6.980 | 9.7% |
| NestJS (Express) | 9,580 | 56 | 6.384 | 9.030 | 7.4% |

**Path parameter** - `GET /params/42`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) | 126,000 | 3,339 | 0.485 | 0.985 | 100.0% |
| Elysia | 124,507 | 5,157 | 0.473 | 0.988 | 98.8% |
| **@dunx/http** | **123,263** | 1,851 | 0.494 | 0.993 | **97.8%** |
| Hono (Bun) | 82,991 | 2,199 | 0.756 | 1.471 | 65.9% |
| @dunx/http (+ request logging) | 69,156 | 1,658 | 0.862 | 1.666 | 54.9% |
| node:http (raw) | 49,387 | 2,342 | 1.253 | 2.488 | 39.2% |
| Fastify (Node) | 42,289 | 2,196 | 1.523 | 1.808 | 33.6% |
| Hono (Node) | 36,539 | 1,323 | 1.746 | 2.005 | 29.0% |
| NestJS (Fastify) | 35,534 | 570 | 1.759 | 3.451 | 28.2% |
| Express (Node) | 11,904 | 51 | 5.134 | 7.260 | 9.4% |
| NestJS (Express) | 9,243 | 42 | 6.643 | 9.256 | 7.3% |

**Body validation** - `POST /validate`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) | 84,701 | 3,196 | 0.734 | 1.458 | 100.0% |
| **@dunx/http** | **78,311** | 1,385 | 0.774 | 1.538 | **92.5%** |
| Elysia | 70,831 | 1,775 | 0.842 | 1.662 | 83.6% |
| @dunx/http (+ request logging) | 56,872 | 2,628 | 1.087 | 1.583 | 67.1% |
| Hono (Bun) | 51,793 | 705 | 1.178 | 2.329 | 61.1% |
| node:http (raw) | 33,538 | 1,001 | 1.852 | 3.687 | 39.6% |
| Hono (Node) | 21,447 | 535 | 2.883 | 5.677 | 25.3% |
| Fastify (Node) | 19,019 | 79 | 3.164 | 6.220 | 22.5% |
| NestJS (Fastify) | 16,008 | 162 | 3.791 | 6.284 | 18.9% |
| Express (Node) | 9,190 | 62 | 6.626 | 9.432 | 10.9% |
| NestJS (Express) | 7,626 | 25 | 8.053 | 11.447 | 9.0% |

**Startup** - cold process to first served request, 7 samples

| Subject | median ms | min ms | max ms |
| ------- | --------: | -----: | -----: |
| Bun.serve (raw) | 26.7 | 26.2 | 28.9 |
| Hono (Bun) | 32.1 | 30.6 | 37.0 |
| **@dunx/http** | **53.1** | 52.4 | 54.6 |
| @dunx/http (+ request logging) | 53.6 | 52.9 | 55.9 |
| Elysia | 58.2 | 57.3 | 61.5 |
| node:http (raw) | 72.8 | 65.4 | 80.3 |
| Hono (Node) | 94.2 | 89.8 | 95.9 |
| Express (Node) | 120.2 | 114.6 | 122.4 |
| Fastify (Node) | 146.1 | 139.6 | 165.8 |
| NestJS (Express) | 270.7 | 266.5 | 283.4 |
| NestJS (Fastify) | 285.5 | 278.8 | 290.0 |

### What these say, including where dunx loses

**The dunx tax over raw `Bun.serve`** - the number this harness exists to produce:

| Scenario | Bun.serve | @dunx/http | dunx costs |
| -------- | --------: | ---------: | ---------: |
| `plaintext` | 138,507 | 135,442 | −2.2% |
| `json` | 130,055 | 123,306 | −5.2% |
| `params` | 126,000 | 123,263 | −2.2% |
| `validate` | 84,701 | 78,311 | −7.5% |

**A figure at or above 100% is noise, not a win.** `@dunx/http` dispatches
*through* `Bun.serve`; it cannot serve a request faster than the API it calls. When
the two land within each other's standard deviation - which they now do on
`plaintext` - the honest reading is "no measurable overhead", not "faster than
`Bun.serve`". Differences under about 3% on this setup are noise.

**`dunx-logging` is the same app with `requestLogging` left at its default**, and
the gap to `dunx` is one structured line per request: reading `req.headers`, an
`AsyncLocalStorage` scope, building the entry, `JSON.stringify`, and the write.
Nothing else in this table logs anything, which is why the two rows exist separately see "Why dunx appears twice". A third harness decomposes that gap step by step; see
"Request logging cost" below.

**Validation is still the largest absolute cost**, but most of it is not the
framework's and not the validator's. Splitting it took a second harness - see
"Validation cost" below - and the answer is that `req.json()` costs about 3 µs while
zod costs about 1 µs. dunx's own share of the `validate` row was 3.7 µs per request
and is now ~1.4 µs, which moved it from 84% of the baseline to over 90% and past
Elysia on this scenario. What remains is dispatch, not validation.

**Cold start is dunx's clearest loss**: roughly twice raw `Bun.serve`, from the
`oxc-parser` preload and eager DI resolution. It does beat Elysia, and every Node
subject by a wide margin, but it is the number to watch if boot time matters.

## How to read the results

- **`vs bun-serve`** is the column that matters for dunx. It is the fraction of raw
  `Bun.serve` throughput the subject achieved on that scenario. For `@dunx/http` it
  is the cost of the framework: routing, the middleware chain, response coercion, and
  for `validate`, the input reader.
- **Compare within a runtime first.** Bun subjects beating Node subjects is a
  statement about Bun, not about the frameworks. `hono-bun` versus `hono-node` is the
  same application code on both runtimes and isolates that term.
- **`validate` minus `json`** is the validation plumbing cost, with the validator
  held constant. Compare that delta, not the absolute.
- **Standard deviation** is across whole runs. If it is a large fraction of the
  median, the machine was busy and the run should be repeated.
- **`bad`** counts non-2xx responses plus transport errors across all measured runs.
  Anything other than 0 invalidates that row.
- **Differences under about 3 points are noise on this setup, and that was measured
  rather than assumed.** Two full runs on the same idle machine, same code, moved
  `@dunx/http`'s `vs bun-serve` figure by up to **3.2 points** (`params` 96.2% ->
  93.0%) while the baseline's own absolute throughput moved by up to **7.7%**
  (`json` 106,817 -> 115,031 req/s). So: read a gap of 5+ points as signal, read 2 as
  nothing, and do not quote an absolute as capacity. Nothing external was competing -
  `oha` and the subject were the only things on the CPU - so this is the machine's own
  frequency behaviour, not contention.

## Validation cost

Generated from `results/validation.json` by `bun src/readme-tables.ts` - never
transcribed by hand. Reproduce with `bun run validation`.

The main suite above holds the validator constant at zod on purpose, which folds two
costs into one number: what parsing and validating cost *at all*, and what
`@dunx/http` adds on top. This section separates them.

```
AMD Ryzen 9 5950X 16-Core Processor, 32 logical cores | bun 1.3.14 | oha oha 1.15.0
64 connections | 3s warmup | 5 x 4s measured | 2026-08-01
```

**Every row is one fresh process, and the measured rounds are interleaved across all
of them** rather than run to completion one row at a time - the differences here are
2-4% and the machine drifts by more than that over a run. Read anything under about
**±0.3 µs** as unresolvable: that is what the run-to-run standard deviations work out
to at this throughput.

### Parsing costs more than validating

Four raw `Bun.serve` routes, each doing exactly one thing more than the one above
it, all answering the same bytes:

| Step | req/s | µs/req | this step adds |
| ---- | ----: | -----: | -------------: |
| `GET /json` - no request body at all | 113,881 | 8.78 | - |
| `POST`, body on the wire, never read | 110,537 | 9.05 | +0.27 µs |
| `POST` + `await req.json()` | 82,341 | 12.14 | +3.10 µs |
| `POST` + `req.json()` + zod | 76,412 | 13.09 | +0.94 µs |

**`req.json()` is the expensive step by a wide margin**, and putting the body on the
wire is near-free - the difference between *sending* it and *reading* it is what
costs. No framework can remove that, and no choice of validator affects it. The
primitive that would is a validating parser Bun does not ship; see
[`docs/bun-apis.md`](../../docs/bun-apis.md).

### Validators through the same Standard Schema seam

The same dunx app and the same schema shape, with only the library behind
`~standard` changed. **costs** is that validator's own time - the raw `Bun.serve`
row's µs/req above the `req.json()`-only row.

| Validator | costs | raw `Bun.serve` req/s | `@dunx/http` req/s | dunx vs raw |
| --------- | ----: | --------------------: | -----------------: | ----------: |
| typebox | -0.01 µs | 82,376 | 71,640 | 87.0% |
| ajv | 0.34 µs | 80,098 | 71,996 | 89.9% |
| arktype | 0.42 µs | 79,568 | 72,600 | 91.2% |
| valibot | 0.89 µs | 76,735 | 67,663 | 88.2% |
| zod | 0.94 µs | 76,412 | 68,843 | 90.1% |
| noop | 0.04 µs | 82,056 | 71,239 | 86.8% |
| noop-async | 0.72 µs | 77,719 | 69,725 | 89.7% |

**zod, Valibot and ArkType are within noise of each other**, and the two compiled
options are at or below what this harness can resolve at this payload size. Every one
of them is cheaper than `req.json()`, so **there is no throughput argument for
choosing between them** - pick on API, error quality and ecosystem. If a profile
genuinely points at validation, the compiled route is there.

`noop` and `noop-async` are the last two rows and are not validators: `noop` is a
hand-written pass-through, which is dunx's plumbing with the validator's cost taken
out, and `noop-async` is the same thing behind a resolved promise - so the gap
between them is what a validator that answers asynchronously costs.

Neither TypeBox 0.34 nor ajv 8 ships `~standard`. Both were bridged in about ten
lines each in `servers/validation/schemas.ts`: a boolean `Check` plus the library's
error iterator, behind a `~standard.validate`. That a compiled JSON Schema checker
drops into a dunx route with no change to `@dunx/http` is the point of targeting an
interface rather than a library.

### Where dunx's own cost goes

| Subject | req/s | µs/req |
| ------- | ----: | -----: |
| raw `Bun.serve`, parse in the handler | 82,341 | 12.14 |
| `@dunx/http`, no schemas, parse in the handler | 76,813 | 13.02 |
| `@dunx/http`, no schemas, validate in the handler | 67,932 | 14.72 |
| `@dunx/http`, `body` declared - the framework does it | 68,843 | 14.53 |

The two `manual` rows declare no schemas and do the work inside the handler, which
keeps them on the synchronous dispatch path - so they separate dunx's **dispatch**
cost from its **input reader** cost. Dispatch is the second row minus the first.

The reader is the fourth row minus the third, and it is now at or below zero: the
framework's reader costs no more than writing `validate(await req.json())` in the
handler yourself. It used to cost **2.05 µs more**, which was twice what zod itself
cost - the reason is in
[`docs/architecture/cost-of-logging.md`](../../docs/architecture/cost-of-logging.md), "The cost of request
validation".

## How the validation harness works

`bun run validation` spawns one process per row, exactly like `start`, and verifies
each one answers the same bytes before measuring it. There are two subject files:

- **`servers/validation/raw.ts`** - raw `Bun.serve`, four routes each doing one thing
  more than the last: `GET /json` (no body), `POST /discard` (body on the wire, never
  read), `POST /parse` (`await req.json()`), `POST /validate` (parse + validate). The
  differences between consecutive rows are the decomposition.
- **`servers/validation/dunx.ts`** - a dunx app with `POST /validate` (a declared
  `body` schema, so the framework parses and validates) plus `POST /manual-parse` and
  `POST /manual-validate`, which declare nothing and do the same work inside the
  handler. Those two separate dunx's dispatch cost from its input-reader cost.

`servers/validation/schemas.ts` holds the one schema shape in every library, loaded by
**dynamic import** so a process measuring Valibot does not pay ArkType's
module-evaluation cost. `--validators zod,valibot` narrows the run.

Caveats specific to this harness, in the same spirit as the handicaps above:

- **The email check is not literally identical across libraries.** zod, Valibot and
  ArkType each bring their own regex; TypeBox and ajv validate `format` only against a
  registered checker, so both are given the *same* regex rather than a library one.
  This is the one place the five schemas are not the same work.
- **Unknown-key handling differs.** zod and Valibot strip; ArkType and the JSON Schema
  subjects are configured without `additionalProperties: false`. The benchmark body has
  no extra keys, so it does not show up here - it would on a wider payload.
- **`noop` and `noop-async` are not validators.** They are hand-written pass-through
  Standard Schemas, present to measure dunx's plumbing with the validator's cost
  removed, and to confirm that an async validator still works and what it costs.
- One payload, 69 bytes, three fields. Nothing here predicts a deeply nested schema,
  where the engines diverge much more than they do at this size.

## Request logging cost

Generated from `results/logging.json` by `bun src/readme-tables.ts` - never
transcribed by hand. Reproduce with `bun run logging`.

`dunx-logging` in the main suite is one number, and one number cannot say *which*
part of writing a structured line per request is expensive. Every row below is the
same app on the same `json` route, in its own process, with one more
piece of the default logging path switched on than the row above it.

```
AMD Ryzen 9 5950X 16-Core Processor, 32 logical cores | bun 1.3.14 | oha oha 1.15.0
64 connections | 3s warmup | 5 x 4s measured | 2026-08-02
```

**Measured round-robin across all rows**, for the reason the validation harness
records: the differences are a few percent and the machine drifts by more than that
over a run. Read anything under about **±0.5 µs** as unresolvable.

| Step | req/s | µs/req | this step adds | total |
| ---- | ----: | -----: | -------------: | ----: |
| `requestLogging: false` | 115,307 | 8.67 | - | - |
| one middleware that only calls `next()` | 114,650 | 8.72 | +0.05 µs | +0.05 µs |
| + the pathname sliced out of `req.url` | 105,844 | 9.45 | +0.73 µs | +0.78 µs |
| + `x-request-id` and `user-agent` read | 93,148 | 10.74 | +1.29 µs | +2.06 µs |
| + `crypto.randomUUID()` | 92,793 | 10.78 | +0.04 µs | +2.10 µs |
| + `runWithContext` around the handler | 85,556 | 11.69 | +0.91 µs | +3.02 µs |
| + `x-request-id` set on the response | 85,806 | 11.65 | −0.03 µs | +2.98 µs |
| + the real middleware, `Logger` discards | 80,290 | 12.45 | +0.80 µs | +3.78 µs |
| + `new Date().toISOString()` | 79,218 | 12.62 | +0.17 µs | +3.95 µs |
| + the entry and `JSON.stringify`, string dropped | 68,180 | 14.67 | +2.04 µs | +5.99 µs |
| batched instead - **the shipped default** | 71,151 | 14.05 | −0.61 µs | +5.38 µs |

Reading it: the middleware chain, `crypto.randomUUID()` and setting
`x-request-id` on the response are each at or below what this harness can resolve.
What costs is the **first touch of `req.headers`**, the `AsyncLocalStorage`
scope, and **building and serialising the entry** - and, before it was batched, the
write.

### The write, and the pipe nobody was reading

| Write | req/s | µs/req |
| ----- | ----: | -----: |
| batched, `/dev/null` | 71,151 | 14.05 |
| one `console.log` per entry, `/dev/null` | 62,851 | 15.91 |
| batched, into a pipe nobody reads | 65,746 | 15.21 |
| one per entry, into a pipe nobody reads | 53,796 | 18.59 |

The last row is what this harness was reporting before either fix, and neither of
its two costs is a property of `@dunx/http`. Subjects were spawned with
`stdout: 'pipe'` and nothing ever read it: 64 KiB in, the pipe is full and the
server parks on every further write. Subjects now write to `/dev/null`, and
`ConsoleLogger` batches everything at `info` and below into one write per
event-loop turn - which also makes a slow consumer far less able to stall the
server. `warn` and above are never batched.

## Output

The stdout table is for humans. `results/latest.json` (or `--out <path>`) is for
machines - `tools/docs` reads it at build time and renders it as the site's
leading page, so it is committed rather than gitignored. A checkout without it still
builds; the page says there is no run.

`results/validation.json` is the second committed artifact, written by
`bun run validation` and read by `src/validation-tables.ts` to render the
"Validation cost" section. Its shape is `ValidationReport` in `src/types.ts`. Nothing
outside this workspace reads it, and a checkout without it still regenerates the
rest of the README.

`results/logging.json` is the third, written by `bun run logging` and read by
`src/logging-tables.ts` for the "Request logging cost" section. Its shape is
`LoggingReport` in `src/types.ts`.

**A subject's stdout goes to `/dev/null`** (`StdoutSink` in
`src/subject-process.ts`). It used to be a pipe nobody read, which meant a subject
that logged parked on a full 64 KiB pipe - worth 2.68 µs/request, and a property of
the harness rather than of the framework. The logging harness keeps the blocked case
as an explicit row so the difference stays visible.

`latest.json`'s shape:

```jsonc
{
  "schemaVersion": 1,                 // bump on any breaking shape change
  "generatedAt": "ISO-8601 string",
  "machine": {
    "cpuModel": "string", "cores": 0, "ramGiB": 0.0,
    "platform": "string", "kernel": "string", "arch": "string",
    "bun": "string", "node": "string"
  },
  "loadGenerator": {
    "id": "oha" | "fetch",
    "version": "string",
    "binary": "string | null",
    "limitations": ["string"]         // render these next to any chart
  },
  "config": {
    "connections": 0, "durationSeconds": 0, "warmupSeconds": 0,
    "runs": 0, "startupSamples": 0
  },
  "toolchains": [{                    // one per compiled language that was asked for
    "runtime": "go" | "rust" | "jvm",
    "label": "string",
    "version": "string | null",       // null means absent, and its subjects were skipped
    "subjects": ["string"],
    "buildSeconds": 0.0               // deliberately NOT in the startup column
  }],
  "subjects": [{
    "id": "string", "label": "string",
    "runtime": "bun" | "node" | "go" | "rust" | "jvm",
    "version": "string", "validator": "string",
    "notes": ["string"],              // the handicaps above, per subject
    "entry": "string", "preload": ["string"], "versionOf": "string | null",
    "warmupFloorSeconds": 0           // optional; only `spring` sets it
  }],
  "scenarios": [{
    "id": "string", "title": "string", "description": "string",
    "method": "GET" | "POST", "path": "string",
    "body": "string | undefined", "contentType": "string | undefined",
    "expectStatus": 200, "expectBody": "string", "expectMime": "string"
  }],
  "results": [{
    "subject": "string",              // Subject.id
    "scenario": "string",             // Scenario.id
    "runs": [{                        // one entry per measured run, in order
      "requests": 0, "elapsedSeconds": 0.0, "rps": 0.0,
      "latencyMeanMs": 0.0, "latencyP50Ms": 0.0, "latencyP99Ms": 0.0,
      "non2xx": 0, "errors": 0
    }],
    "rps":          { "median": 0.0, "min": 0.0, "max": 0.0, "stddev": 0.0 },
    "latencyP50Ms": { "median": 0.0, "min": 0.0, "max": 0.0, "stddev": 0.0 },
    "latencyP99Ms": { "median": 0.0, "min": 0.0, "max": 0.0, "stddev": 0.0 },
    "totalErrors": 0, "totalNon2xx": 0
  }],
  "startup": [{
    "subject": "string", "samplesMs": [0.0], "medianMs": 0.0
  }]
}
```

`results` is a flat list; join on `subject` and `scenario`. A `(subject, scenario)`
pair missing from it was not run.

## Layout

```
tools/bench/
  servers/            one file per subject, each readable end to end
    shared.ts         the payloads and the one zod schema every subject validates with
    validation/       the validation harness's two subjects
      raw.ts          raw Bun.serve, one route per step of the decomposition
      dunx.ts         the dunx app, declared and hand-written variants
      schemas.ts      the one schema shape in every library, dynamically imported
    logging/          the request-logging harness's one subject
      dunx.ts         the app, with the middleware truncated at $LOGGING_VARIANT
      variants.ts     the step list and the three stand-in Logger bindings
    go/               one Go module, one command per subject
      shared/         the payloads and the one validator both Go subjects use
      cmd/nethttp/    net/http and http.ServeMux, the Go floor
      cmd/gin/        Gin
    rust/             one Cargo package, one [[bin]] per subject
      src/axum.rs     Axum on tokio, single-threaded
    java/             one Maven project
      src/main/java/bench/App.java   Spring Boot, MVC over Tomcat
  src/
    index.ts          entrypoint for the framework suite
    validation.ts     entrypoint for the validation harness
    logging.ts        entrypoint for the request-logging harness
    cli.ts            flags
    run.ts            orchestration: startup, warmup, measured runs
    subject-process.ts  spawn, readiness, contract verification, stop
    build.ts          Bun.build transpile of the Node subjects
    toolchains.ts     probe, compile and skip for the Go, Rust and JVM subjects
    scenarios.ts      the four workloads and their exact expected responses
    subjects.ts       the subject registry, including each one's handicaps
    loadgen/          oha adapter, Bun fetch driver, worker, histogram
    report.ts         the stdout table
    readme-tables.ts  regenerates every generated README section
    validation-tables.ts  the "Validation cost" section
    logging-tables.ts     the "Request logging cost" section
    machine.ts        CPU/RAM/OS/runtime/package versions
    stats.ts          median, stddev, spread
```

## Adding a subject

1. Write `servers/<name>.ts`. It must read `PORT` from the environment and answer all
   four scenarios with byte-identical responses. Copy `servers/hono.ts`.
2. Add an entry to `src/subjects.ts`, including a `validator` string and a `notes`
   array naming anything that flatters or handicaps it.
3. `bun run start --subjects <name>`. The contract check will tell you what does
   not match.

Node subjects need nothing extra - `src/build.ts` finds them by `runtime: 'node'`.

A subject in an **existing** compiled language needs its source under
`servers/go`, `servers/rust` or `servers/java`, and the naming the toolchain
expects: a Go subject's `entry` is `servers/go/cmd/<id>/main.go`, a Rust subject
needs a `[[bin]]` in `Cargo.toml` named after its id, and a JVM subject's
`finalName` in `pom.xml` must be its id. It must also be single-threaded, for the
reason in "Reading the Go, Rust and JVM rows fairly".

A **new** language is one entry in `TOOLCHAINS` in `src/toolchains.ts`: the
binaries to probe, the environment variables that override them, the hint printed
when they are missing, and a `compile` returning the argv that runs the artifact.

## Requirements

Only the first is required. Every other row is opt-in: the harness probes for it,
and if it is not there it prints a line naming the subjects it is skipping and
still produces a report. That is what keeps the suite runnable in CI, which has
none of them.

| Need                     | For                      | Found via                        |
| ------------------------ | ------------------------ | -------------------------------- |
| **Bun**                  | the harness, Bun subjects | required                        |
| Node                     | the four Node subjects   | `PATH`, or `$BENCH_NODE`         |
| Go 1.22+                 | `nethttp`, `gin`         | `PATH`, or `$BENCH_GO`           |
| Rust / Cargo             | `axum`                   | `PATH`, or `$BENCH_CARGO`        |
| JDK 21+ **and** Maven    | `spring`                 | `PATH`, or `$BENCH_JAVA` and `$BENCH_MVN` |
| Python 3.10+ with Django | `django`                 | `PATH`, or `$BENCH_PYTHON`       |

Django has to be **importable**, not merely on disk: the probe runs
`import django` and skips the subject with a clear line if that fails, rather than
letting it start and be rejected later by the equivalence check. If Django is not
installed system-wide, `$BENCH_PYTHONPATH` can point at a directory holding an
extracted wheel - Django is pure Python, so nothing needs building or installing:

```bash
curl -sfLO https://files.pythonhosted.org/.../Django-5.1.4-py3-none-any.whl
python3 -c "import zipfile; zipfile.ZipFile('Django-5.1.4-py3-none-any.whl').extractall('pylib')"
BENCH_PYTHONPATH=$PWD/pylib bun run start --subjects django
```

Nothing here is downloaded or installed for you - `bun run setup` fetches oha and
that is all. The first build of each is slow (Go and Maven resolve dependencies
from the network, Rust compiles about 200 crates); every run after that is cached.
Maven's local repository is `.bin/m2` rather than `~/.m2`, so a benchmark run
leaves nothing behind outside this workspace.
