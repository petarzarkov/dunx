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
bun run start       # full suite: 19 subjects x 4 scenarios, minus any whose toolchain is absent
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
| `aspnet-minimal`  | .NET    | ASP.NET Core minimal APIs on Kestrel: the .NET floor, routes as lambdas.       |
| `aspnet-mvc`      | .NET    | The same runtime and server with MVC on top: controllers, model binding, DI.   |
| `django`          | Python  | Django on gunicorn with one worker, `DEBUG` off and no middleware.             |
| `fastapi`         | Python  | FastAPI on uvicorn with one worker, async ASGI, validating with pydantic.      |

Each subject is a single file under `servers/`, small enough to read in full. If a
number looks wrong, read the file - that is the whole implementation.

The last eight need a toolchain this repo does not otherwise use. They are
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

#### Reading the Python rows fairly

Two subjects, and they answer different questions.

**`fastapi` is the closest thing in this suite to a like-for-like comparison with
`@dunx/http`.** Both are async, both take a schema and carry its types into the
handler, and both are the framework people reach for when they want that. So
`validate` is the scenario to read it on: dunx validates with zod through Standard
Schema, Elysia with TypeBox, FastAPI with pydantic, and that is three ecosystems
doing one job. The other three scenarios are dispatch and serialisation, where
FastAPI is carrying an ASGI stack the Bun subjects do not have.

**`django` is the batteries-included synchronous comparison**, and its handler
blocks its worker for the request's whole duration. One gunicorn worker against one
core is the fair shape here and it is not how Django is deployed; a real deployment
runs several workers. Read it as one worker against one worker.

Neither row is pinned the way Go, tokio and Tomcat are, because neither needed it:
one gunicorn worker and one uvicorn worker are already one thread each. Both are
interpreted, so there is no artifact and no build time to keep out of the startup
column - and both pay interpreter startup plus imports in it, which is a real cost
and not an artefact.

**Neither is running its fastest available configuration, and that is deliberate.**
`uvicorn[standard]` would bring uvloop and httptools; this measures plain asyncio,
which is what `pip install fastapi uvicorn` gives. Naming the floor is more useful
than tuning one subject that nothing else in the suite is tuned against.

#### Reading the .NET rows fairly

The pair answers a question the JavaScript rows can only answer across runtimes:
**what does the controllers-and-DI programming model cost with everything
underneath it held still?** `aspnet-minimal` and `aspnet-mvc` are the same
Kestrel, the same runtime, the same JSON serialiser and the same validator. MVC
adds attribute routing, model binding, the filter pipeline, automatic model
validation and a controller resolved from the container on every request, and the
gap between the two rows is that and nothing else - the `nest-express` against
`express` comparison, in a compiled language, with the runtime term removed.

So `aspnet-mvc` is the closest cross-language neighbour of the `spring` and NestJS
rows, and `aspnet-minimal` is the .NET analogue of `node-http` and `bun-serve`.
Read dunx against `bun-serve` and MVC against `aspnet-minimal` before reading dunx
against either .NET row.

What the published run says: MVC costs **16% of `aspnet-minimal` on `plaintext`,
20% on `json` and 31% on both `params` and `validate`**. Against the same figure
for Nest on Fastify (12%, 14%, 18%, 15%) and for dunx on `Bun.serve` (2.0%, 4.5%,
4.1%, 8.8%), MVC is the most expensive of the three programming models relative to
its own floor - and still 2.4x NestJS-on-Fastify and 1.6x Spring in absolute
throughput, because the floor it is paying that tax on is a different height.
`params` is where it costs most, which is route-value plus action-parameter model
binding rather than dispatch.

Both are `dotnet publish -c Release` and nothing else: no ReadyToRun, no Native
AOT, no trimming, no invariant globalization. Native AOT would take most of the
startup number away and is what a .NET benchmark usually ships; it is not what
`dotnet new webapi` gives anyone, and nothing else in this suite is tuned that way
either.

Neither row logs. ASP.NET Core's hosting layer writes two Information entries per
request out of the box, which is what the default template's `appsettings.json`
turns off; both subjects do the same in the file you are reading, for the reason
the `dunx` and `dunx-logging` split exists.

#### Reading the Go, Rust, JVM and .NET rows fairly

These six exist as a **falsification test on this harness**, not as a
scoreboard. Elysia's landing page shows a JavaScript runtime beating Gin by 3.6x
and Spring by 4.8x, which is not a plausible framework result, and the same
question applies here: if `@dunx/http` comes out ahead of Gin or Axum, the first
conclusion to reach for is that the harness is measuring something other than
what it claims.

Three things make these rows readable, and every one of them is a constraint
that has to be stated with the number:

**Threads.** Every subject in this suite is one process on one thread. Bun and
Node are single-threaded because that is what they are; Go, tokio, Tomcat and
Kestrel are single-threaded here because the harness **made** them, and that is
the largest handicap in the file. `runtime.GOMAXPROCS(1)`, `#[tokio::main(flavor =
"current_thread")]` and `server.tomcat.threads.max=1` are in three of the source
files. The .NET pair takes a fourth route: `DOTNET_PROCESSOR_COUNT=1` in the
environment, because the runtime reads it once as it starts and it is what sizes
the GC heaps, the thread pool and Kestrel's IO queues. `Shared.PinToOneThread`
caps the pool at one worker on top of it and throws if that variable is absent,
so the pinning cannot be lost by launching the process another way.

Without any of this a 32-core Go server would be measured against a
single-threaded JavaScript one, which ranks the machine and not the framework.
With them, the ranking is per-thread dispatch cost, which is the only thing the
rest of this table has ever measured - and which is **not** what anyone deploying
Go, Rust or .NET actually gets. Measured on the machine below at the same 64
connections: raw `net/http` goes from about 73k req/s at `GOMAXPROCS(1)` to about
230k with all 32 cores, Axum from about 121k to about 503k, and `aspnet-minimal`
from about 88k to about 377k. Neither Bun subject can move at all, because
`Bun.serve` is one thread.

**Compilation is not startup.** The Go and Rust binaries, the Spring fat jar and
the two .NET publish outputs are all built in a prepare pass before anything is
measured, and the build time is reported next to the toolchain rather than inside
the startup column. So the startup column times the same thing for everyone: a
cold process answering its first request. That is honest for Go and Rust, where
the compile is genuinely somebody else's problem at deploy time, and it is honest
for the JVM and .NET too - class or assembly loading and a JIT-free first request
are real costs both pay every boot, and they stay in the number.

**JIT warmup.** Three seconds warms neither a JVM nor a .NET runtime, so `spring`,
`aspnet-minimal` and `aspnet-mvc` get a 30-second unmeasured warmup instead,
recorded per subject in the report and printed above the tables. Reporting a cold
JVM would be exactly the kind of flattering measurement this file exists to avoid,
pointed the other way, and .NET turned out to need it just as badly: measured,
`aspnet-minimal` served 40k req/s on the `json` scenario after a 3-second warmup,
was still climbing 20 seconds later and plateaued near 88k. Quoting the first
number would have understated it by 2.2x.

**The validator is not held constant across languages.** Inside JavaScript every
subject validates with zod, which is what makes `validate` minus `json` readable.
There is no zod in Go, Rust, Java or C#, so each uses the idiomatic choice -
`go-playground/validator`, the `validator` crate, Hibernate Validator,
DataAnnotations - and each brings its own email regex. Compare the cross-language
`validate` rows to their own `json` row, not to a JavaScript subject's.

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
5. **Measured rounds are interleaved across every subject.** One scenario at a
   time: all subjects are brought up and warmed, then each measured round visits
   every one of them in turn, then all are torn down. Default 5 rounds of 5 s. The
   report gives the **median** and the **standard deviation** across rounds, never a
   single round. See "Interleaving, and the drift it removes" for why this is not
   subject-at-a-time.
6. **Startup is measured separately**, before any load, by spawning and killing the
   subject N times (default 7) and timing spawn to first successful response. It
   cannot be interleaved - it is one process at a time by definition - and running
   it first means no measured round shares the machine with a cold start. For the
   compiled subjects that is the artifact, never the build - see "Reading the Go,
   Rust and JVM rows fairly".
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

## Which cross-language rows are in the tables below

`nethttp`, `gin`, `axum`, `spring`, `aspnet-minimal`, `aspnet-mvc`, `django` and
`fastapi` are implemented and pass the contract check. Whether a row appears depends
on the toolchain being installed on the machine that took the run, because a missing
one is a skip rather than a failure.

The published `results/latest.json` was taken with all five toolchains present, so
**every subject is in the tables**. A checkout without them produces a shorter
report and still exits 0; every table here is generated from that one file rather
than typed, so a row is either measured or absent and never guessed at.

What a clean run should be read for, in this order: whether the load generator has
headroom over the fastest row (see "Load generator"), then whether the JavaScript
rows sit above Gin, Axum and the .NET pair - and if they do, "Reading the Go, Rust,
JVM and .NET rows fairly" is the paragraph that says what that does and does not
mean.

## Interleaving, and the drift it removes

This suite used to measure each subject to completion in turn, and the numbers it
produced were noisier than their own `stddev` column claimed.

**The measurement that found it.** Two full runs of the **same** code on the same
idle machine under Bun 1.4.0, subject-at-a-time, diffed per scenario:

| Subject          | plaintext | json   | params | validate |
| ---------------- | --------- | ------ | ------ | -------- |
| `bun-serve`      | +2.2%     | +3.0%  | +5.8%  | +6.0%    |
| `@dunx/http`     | +3.9%     | +10.1% | +1.8%  | +4.9%    |
| Elysia           | +7.9%     | +7.3%  | +8.7%  | +6.8%    |
| Hono (Bun)       | +1.8%     | -0.0%  | -1.4%  | -2.1%    |
| `node:http` raw  | +4.8%     | -0.1%  | +1.5%  | -3.7%    |

Median +3.9%, worst +10.1%, and **15 of 20 cells moved the same direction**. A
symmetric spread around zero would be sampling noise; a one-directional shift is the
machine being in a different state for the second run. The within-round `stddev` was
1% to 3% throughout, so five rounds of five seconds were already agreeing with each
other - the variance was *between* runs, not inside them, and no amount of extra
duration addresses that.

Subject-at-a-time also maps that drift onto **subject identity**, which is worse than
making the absolute numbers noisy. A full run takes tens of minutes, so `bun-serve`
was measured first and `django` some forty minutes later, and their ratio was
published as though the two numbers were simultaneous. The gap this harness exists to
report - `@dunx/http` against raw `Bun.serve` - is 0.1% to 8%, entirely inside the
drift.

So the measured rounds are now **interleaved**: per scenario, every subject is brought
up and warmed, then each round visits all of them in turn. The three other harnesses
here did this from the start, and `src/validation.ts` gives the reason for differences
"often 2-4%" - the first attempt at that one had `raw:parse` come out faster than
`raw:noop`, which does strictly more work. This is that argument reaching the suite
whose differences got small enough to need it.

**It works, and here is the check.** Two interleaved full runs, same code, same
machine, against the two sequential ones above:

| | sequential | interleaved |
| --------------------------------- | ---------- | ----------- |
| cells moving the **same** direction | 15/20 (75%) | **23/68 (34%)** |
| median signed delta               | **+3.9%**  | **-0.6%**   |
| median absolute delta             | 3.9%       | **1.2%**    |
| worst absolute delta              | 10.1%      | 8.0%        |

The systematic bias is what mattered and it is gone: a median signed delta near zero
with a roughly even direction split is sampling noise, where +3.9% with three quarters
of cells moving together was drift. On the published ratio - each subject as a
percentage of `bun-serve` - the two runs disagree by a **median of 0.6 percentage
points and at worst 4.8**. So a three-point gap is now readable, where before nothing
under ten was.

Read a single run's ratio as +/- 1 point, and anything under about 3 points as a tie.

What it costs, stated because it is a real trade: every subject in the run holds a
live process and a listening socket while any one of them is measured. They are idle,
so they take memory and file descriptors rather than CPU, and on this machine that is
17 servers against 62 GiB. On a small box, run fewer subjects with `--subjects`.

**Numbers taken before this change are not comparable with numbers taken after it**,
and the ones in this file are from after.

## Results

Generated from `results/latest.json` by `bun src/readme-tables.ts` - never
transcribed by hand.

```
AMD Ryzen 9 5950X 16-Core Processor, 32 logical cores, 62.7 GiB RAM
linux 7.0.0-30-generic x64 | bun 1.4.0 | node v20.20.2 | oha oha 1.15.0
64 connections | 3s warmup | 5 x 5s measured | 2026-08-26
dunx-logging 3.0.1 | elysia 1.4.29 | nest-express 11.1.28 | nest-fastify 11.1.28 | hono-bun 4.12.33 | hono-node 4.12.33 | fastify 5.11.0 | express 5.2.1 | gin v1.12.0 | axum 0.8.9 | spring 4.1.0 | aspnet-minimal net10.0 | aspnet-mvc net10.0 | django 6.1 | fastapi 0.141.1
```

Reproduce with `bun run start`; the full JSON lands in `results/latest.json`.

**Plain text** - `GET /plaintext`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) | 115,298 | 1,990 | 0.527 | 1.077 | 100.0% |
| **@dunx/http** | **113,030** | 2,409 | 0.535 | 1.088 | **98.0%** |
| Elysia | 111,396 | 3,935 | 0.551 | 1.117 | 96.6% |
| Axum (Rust) | 109,690 | 4,524 | 0.572 | 0.786 | 95.1% |
| Hono (Bun) | 104,270 | 1,939 | 0.590 | 1.184 | 90.4% |
| ASP.NET Core minimal APIs | 94,487 | 3,255 | 0.658 | 0.932 | 82.0% |
| ASP.NET Core MVC | 79,449 | 2,151 | 0.774 | 1.107 | 68.9% |
| @dunx/http (+ request logging) | 69,909 | 2,769 | 0.860 | 1.677 | 60.6% |
| Gin (Go) | 65,671 | 2,543 | 0.971 | 2.157 | 57.0% |
| net/http (Go) | 60,074 | 2,816 | 1.058 | 2.263 | 52.1% |
| Spring Boot (JVM) | 43,797 | 1,140 | 1.408 | 2.095 | 38.0% |
| node:http (raw) | 38,841 | 816 | 1.607 | 3.015 | 33.7% |
| Fastify (Node) | 35,387 | 2,405 | 1.794 | 2.308 | 30.7% |
| Hono (Node) | 34,017 | 934 | 1.802 | 2.418 | 29.5% |
| NestJS (Fastify) | 31,225 | 405 | 1.971 | 2.898 | 27.1% |
| Express (Node) | 11,816 | 177 | 5.004 | 7.455 | 10.2% |
| NestJS (Express) | 9,230 | 130 | 6.429 | 9.655 | 8.0% |
| FastAPI (Python) | 7,057 | 89 | 8.996 | 9.631 | 6.1% |
| Django (Python) | 4,221 | 41 | 15.229 | 16.507 | 3.7% |

**JSON** - `GET /json`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) | 111,883 | 1,024 | 0.544 | 1.097 | 100.0% |
| Elysia | 107,020 | 282 | 0.567 | 1.145 | 95.7% |
| **@dunx/http** | **106,867** | 1,563 | 0.567 | 1.149 | **95.5%** |
| Axum (Rust) | 104,493 | 3,153 | 0.599 | 0.814 | 93.4% |
| Hono (Bun) | 93,598 | 1,531 | 0.642 | 1.288 | 83.7% |
| ASP.NET Core minimal APIs | 91,573 | 2,331 | 0.692 | 0.890 | 81.8% |
| ASP.NET Core MVC | 73,097 | 1,767 | 0.868 | 1.180 | 65.3% |
| @dunx/http (+ request logging) | 69,164 | 1,605 | 0.868 | 1.722 | 61.8% |
| net/http (Go) | 61,779 | 2,468 | 1.033 | 2.255 | 55.2% |
| Gin (Go) | 61,016 | 972 | 1.044 | 2.355 | 54.5% |
| Spring Boot (JVM) | 46,073 | 1,088 | 1.371 | 1.643 | 41.2% |
| node:http (raw) | 38,379 | 546 | 1.602 | 3.150 | 34.3% |
| Fastify (Node) | 35,002 | 826 | 1.768 | 2.609 | 31.3% |
| Hono (Node) | 31,045 | 750 | 2.003 | 2.573 | 27.7% |
| NestJS (Fastify) | 30,234 | 375 | 2.069 | 2.758 | 27.0% |
| Express (Node) | 11,331 | 191 | 5.248 | 7.839 | 10.1% |
| NestJS (Express) | 8,958 | 169 | 6.664 | 9.954 | 8.0% |
| FastAPI (Python) | 7,122 | 108 | 8.943 | 10.316 | 6.4% |
| Django (Python) | 4,020 | 58 | 15.755 | 17.167 | 3.6% |

**Path parameter** - `GET /params/42`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) | 111,212 | 3,820 | 0.550 | 1.106 | 100.0% |
| Elysia | 107,220 | 1,586 | 0.560 | 1.143 | 96.4% |
| **@dunx/http** | **106,634** | 2,299 | 0.563 | 1.134 | **95.9%** |
| Axum (Rust) | 100,799 | 2,101 | 0.617 | 0.905 | 90.6% |
| ASP.NET Core minimal APIs | 91,330 | 4,559 | 0.671 | 0.969 | 82.1% |
| Hono (Bun) | 88,063 | 5,004 | 0.704 | 1.403 | 79.2% |
| @dunx/http (+ request logging) | 68,620 | 2,157 | 0.857 | 1.916 | 61.7% |
| ASP.NET Core MVC | 62,901 | 1,333 | 0.986 | 1.359 | 56.6% |
| Gin (Go) | 61,822 | 495 | 1.031 | 2.273 | 55.6% |
| net/http (Go) | 60,265 | 1,892 | 1.056 | 2.266 | 54.2% |
| node:http (raw) | 38,399 | 693 | 1.626 | 3.197 | 34.5% |
| Spring Boot (JVM) | 37,943 | 945 | 1.667 | 2.199 | 34.1% |
| Fastify (Node) | 33,523 | 586 | 1.881 | 2.363 | 30.1% |
| Hono (Node) | 29,861 | 805 | 2.076 | 2.735 | 26.9% |
| NestJS (Fastify) | 27,462 | 473 | 2.253 | 3.328 | 24.7% |
| Express (Node) | 11,212 | 310 | 5.311 | 7.796 | 10.1% |
| NestJS (Express) | 8,575 | 58 | 6.920 | 10.349 | 7.7% |
| FastAPI (Python) | 6,415 | 86 | 9.898 | 10.722 | 5.8% |
| Django (Python) | 4,081 | 41 | 15.439 | 17.151 | 3.7% |

**Body validation** - `POST /validate`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) | 77,297 | 2,024 | 0.781 | 1.557 | 100.0% |
| Axum (Rust) | 76,226 | 1,331 | 0.823 | 1.108 | 98.6% |
| ASP.NET Core minimal APIs | 70,869 | 1,917 | 0.870 | 1.220 | 91.7% |
| **@dunx/http** | **70,514** | 2,585 | 0.854 | 1.694 | **91.2%** |
| Elysia | 65,773 | 3,949 | 0.918 | 1.836 | 85.1% |
| Hono (Bun) | 56,556 | 1,432 | 1.065 | 2.107 | 73.2% |
| @dunx/http (+ request logging) | 50,688 | 3,522 | 1.194 | 2.304 | 65.6% |
| ASP.NET Core MVC | 49,098 | 461 | 1.268 | 1.713 | 63.5% |
| net/http (Go) | 43,727 | 762 | 1.466 | 3.113 | 56.6% |
| Gin (Go) | 42,781 | 806 | 1.498 | 3.286 | 55.3% |
| Spring Boot (JVM) | 28,671 | 1,331 | 2.267 | 2.826 | 37.1% |
| node:http (raw) | 28,200 | 419 | 2.234 | 4.323 | 36.5% |
| Hono (Node) | 18,585 | 341 | 3.367 | 6.542 | 24.0% |
| Fastify (Node) | 16,793 | 218 | 3.481 | 6.818 | 21.7% |
| NestJS (Fastify) | 14,210 | 357 | 4.100 | 8.044 | 18.4% |
| Express (Node) | 8,754 | 41 | 6.785 | 9.989 | 11.3% |
| NestJS (Express) | 7,174 | 265 | 8.305 | 12.036 | 9.3% |
| FastAPI (Python) | 4,195 | 105 | 15.063 | 16.406 | 5.4% |
| Django (Python) | 3,852 | 57 | 16.344 | 18.958 | 5.0% |

**Startup** - cold process to first served request, 7 samples

| Subject | median ms | min ms | max ms |
| ------- | --------: | -----: | -----: |
| Axum (Rust) | 1.8 | 1.6 | 7.0 |
| net/http (Go) | 4.1 | 3.9 | 4.3 |
| Gin (Go) | 4.2 | 3.9 | 5.4 |
| Bun.serve (raw) | 18.3 | 16.9 | 19.9 |
| Hono (Bun) | 23.6 | 22.6 | 24.5 |
| @dunx/http (+ request logging) | 41.8 | 41.3 | 44.6 |
| **@dunx/http** | **42.7** | 40.5 | 45.0 |
| Elysia | 47.4 | 45.5 | 49.5 |
| node:http (raw) | 70.2 | 66.1 | 72.8 |
| Hono (Node) | 93.6 | 91.4 | 98.4 |
| Express (Node) | 121.6 | 118.1 | 124.0 |
| Django (Python) | 131.1 | 127.1 | 144.5 |
| Fastify (Node) | 147.6 | 142.9 | 159.8 |
| FastAPI (Python) | 246.9 | 240.1 | 253.3 |
| NestJS (Express) | 277.4 | 271.4 | 355.4 |
| ASP.NET Core minimal APIs | 280.4 | 269.6 | 289.3 |
| ASP.NET Core MVC | 292.5 | 284.4 | 306.4 |
| NestJS (Fastify) | 293.1 | 279.3 | 329.8 |
| Spring Boot (JVM) | 1285.6 | 1256.3 | 1540.6 |

### What these say, including where dunx loses

**The dunx tax over raw `Bun.serve`** - the number this harness exists to produce:

| Scenario | Bun.serve | @dunx/http | dunx costs |
| -------- | --------: | ---------: | ---------: |
| `plaintext` | 115,298 | 113,030 | −2.0% |
| `json` | 111,883 | 106,867 | −4.5% |
| `params` | 111,212 | 106,634 | −4.1% |
| `validate` | 77,297 | 70,514 | −8.8% |

**A figure at or above 100% is noise, not a win.** `@dunx/http` dispatches
*through* `Bun.serve`; it cannot serve a request faster than the API it calls. When
the two land within each other's standard deviation - which they now do on
`plaintext` - the honest reading is "no measurable overhead", not "faster than
`Bun.serve`". Differences under about 3% on this setup are noise.

**`dunx-logging` is the same app with `requestLogging` left at its default**, and
the gap to `dunx` is one structured line per request: reading `req.headers`, an
`AsyncLocalStorage` scope, building the entry, `JSON.stringify`, and the write.
Nothing else in this table logs anything, which is why the two rows exist separately
- see "Why dunx appears twice". A third harness decomposes that gap step by step; see
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
AMD Ryzen 9 5950X 16-Core Processor, 32 logical cores | bun 1.4.0 | oha oha 1.15.0
64 connections | 3s warmup | 3 x 4s measured | 2026-08-22
```

**Measured round-robin across all rows**, for the reason the validation harness
records: the differences are a few percent and the machine drifts by more than that
over a run. Read anything under about **±0.5 µs** as unresolvable.

> Measured before trace context replaced the request id. The `crypto.randomUUID()`
> row is now `TraceContext.adopt` and the two `x-request-id` rows are `traceparent`
> and `traceresponse`; the next run regenerates the table with those labels.

| Step | req/s | µs/req | this step adds | total |
| ---- | ----: | -----: | -------------: | ----: |
| `requestLogging: false` | 125,312 | 7.98 | - | - |
| one middleware that only calls `next()` | 116,537 | 8.58 | +0.60 µs | +0.60 µs |
| + the pathname sliced out of `req.url` | 107,411 | 9.31 | +0.73 µs | +1.33 µs |
| + `x-request-id` and `user-agent` read | 97,232 | 10.28 | +0.97 µs | +2.30 µs |
| + `crypto.randomUUID()` | 100,161 | 9.98 | −0.30 µs | +2.00 µs |
| + `runWithContext` around the handler | 97,814 | 10.22 | +0.24 µs | +2.24 µs |
| + `x-request-id` set on the response | 95,558 | 10.46 | +0.24 µs | +2.48 µs |
| + the real middleware, `Logger` discards | 92,200 | 10.85 | +0.38 µs | +2.87 µs |
| + `new Date().toISOString()` | 90,465 | 11.05 | +0.21 µs | +3.07 µs |
| + the entry and `JSON.stringify`, string dropped | 77,950 | 12.83 | +1.77 µs | +4.85 µs |
| batched instead - **the shipped default** | 78,377 | 12.76 | −0.07 µs | +4.78 µs |

Reading it: the middleware chain, `crypto.randomUUID()` and setting
`x-request-id` on the response are each at or below what this harness can resolve.
What costs is the **first touch of `req.headers`**, the `AsyncLocalStorage`
scope, and **building and serialising the entry** - and, before it was batched, the
write.

### The write, and the pipe nobody was reading

| Write | req/s | µs/req |
| ----- | ----: | -----: |
| batched, `/dev/null` | 78,377 | 12.76 |
| one `console.log` per entry, `/dev/null` | 65,960 | 15.16 |
| batched, into a pipe nobody reads | 77,030 | 12.98 |
| one per entry, into a pipe nobody reads | 58,232 | 17.17 |

The last row is what this harness was reporting before either fix, and neither of
its two costs is a property of `@dunx/http`. Subjects were spawned with
`stdout: 'pipe'` and nothing ever read it: 64 KiB in, the pipe is full and the
server parks on every further write. Subjects now write to `/dev/null`, and
`ConsoleLogger` batches everything at `info` and below into one write per
event-loop turn - which also makes a slow consumer far less able to stall the
server. `warn` and above are never batched.

### What logging a body costs

Generated from `results/logging-bodies.json`; reproduce with
`bun run logging:bodies`. Same round-robin, but on the `validate`
scenario - a `POST` with a body. The ladder above is a `GET`, so the body options
are unreachable from it, which is why their cost lived in a doc comment rather than in
this harness for as long as it did.

| Setting | req/s | µs/req | vs the default |
| ------- | ----: | -----: | -------------: |
| `requestLogging: false` | 78,110 | 12.80 | −4.45 µs |
| the shipped default, both body options off | 57,970 | 17.25 | - |
| `requestBody: true`, route declares a schema | 52,294 | 19.12 | +1.87 µs |
| `responseBody: true` | 50,494 | 19.80 | +2.55 µs |
| both bodies, schema route | 49,917 | 20.03 | +2.78 µs |
| `requestBody: true`, no schema - `req.clone()` | 21,711 | 46.06 | +28.81 µs |

**The two request-body rows differ by one `Request.clone()` and nothing else.** A
route that declares a `body` schema has its body buffered by the input reader, and
the logger reads that text; a route that declares none leaves the logger to clone the
request, and cloning one whose body is an unread network stream is what the cost has
always been. Not the second parse, which measures at 0.32 µs.

So `requestBody: true` is cheap on a validated route and expensive on an
unvalidated one, and that is the number to quote rather than a single figure.
`responseBody` needs no equivalent: a response is already a materialised string by
the time anything clones it.

## Output

The stdout table is for humans. `results/latest.json` (or `--out <path>`) is for
machines - `internal/docs` reads it at build time and renders it as the site's
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
internal/bench/
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
    dotnet/           one solution-less directory, one project per subject
      Directory.Build.props          the target framework and where builds land
      shared/         the payloads, the validator and the thread pinning
      aspnet-minimal/ minimal APIs on Kestrel, the .NET floor
      aspnet-mvc/     the same server with MVC on top
  src/
    index.ts          entrypoint for the framework suite
    validation.ts     entrypoint for the validation harness
    logging.ts        entrypoint for the request-logging harness
    cli.ts            flags
    run.ts            orchestration: startup, warmup, measured runs
    subject-process.ts  spawn, readiness, contract verification, stop
    build.ts          Bun.build transpile of the Node subjects
    toolchains.ts     probe, compile and skip for the Go, Rust, JVM and .NET subjects
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
`servers/go`, `servers/rust`, `servers/java` or `servers/dotnet`, and the naming
the toolchain expects: a Go subject's `entry` is `servers/go/cmd/<id>/main.go`, a
Rust subject needs a `[[bin]]` in `Cargo.toml` named after its id, a JVM subject's
`finalName` in `pom.xml` must be its id, and a .NET subject's `entry` is
`servers/dotnet/<id>/Program.cs` with the project file named after its id too. It
must also be single-threaded, for the reason in "Reading the Go, Rust, JVM and
.NET rows fairly" - and a .NET one needs `env: { DOTNET_PROCESSOR_COUNT: '1' }` in
its registry entry, which `Shared.PinToOneThread` throws without.

`src/registry.test.ts` checks every one of those namings, so a subject filed in
the wrong place fails a test rather than a run.

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
| .NET SDK 10+             | `aspnet-minimal`, `aspnet-mvc` | `PATH`, or `$BENCH_DOTNET`  |
| Python 3.10+, Django, gunicorn | `django`           | `PATH`, or `$BENCH_PYTHON`       |
| Python 3.10+, FastAPI, uvicorn | `fastapi`          | `PATH`, or `$BENCH_PYTHON`       |

Each package has to be **importable**, not merely on disk: the probe runs
`import <name>` and skips that subject with a clear line if it fails, rather than
letting it start and be rejected later by the equivalence check. **The two Python
subjects are probed separately**, so a machine with Django and no FastAPI runs one
and skips the other.

If the packages are not installed system-wide, `$BENCH_PYTHONPATH` can point at a
directory holding them and nothing needs installing. Both subjects also need a
server - gunicorn for Django, uvicorn for FastAPI - so the shortest route is pip
with `--target`:

```bash
python3 -m pip install --target pylib django gunicorn 'fastapi[standard]' uvicorn
BENCH_PYTHONPATH=$PWD/pylib bun run start --subjects django,fastapi
```

Two traps found installing it this way. `pydantic`'s `EmailStr` needs
`email-validator`, which is `pydantic[email]` and is not pulled in by `fastapi`
alone; without it the module fails to import and the subject skips. And uvicorn's
default `ws="auto"` imports `websockets` eagerly, so a system copy old enough to
lack `ServerProtocol` kills the process at startup - `servers/python/fastapi_app.py`
passes `ws="none"`, which this suite wants anyway.

Nothing here is downloaded or installed for you - `bun run setup` fetches oha and
that is all. The first build of each is slow (Go and Maven resolve dependencies
from the network, Rust compiles about 200 crates); every run after that is cached.
The .NET pair is the exception in both directions: it publishes in about three
seconds from cold and needs no network at all, because neither project references
anything outside the shared framework the SDK already ships.

Maven's local repository is `.bin/m2` rather than `~/.m2`, and NuGet's is
`.bin/nuget` with `DOTNET_CLI_HOME` alongside it, so a benchmark run leaves
nothing behind outside this workspace. Everything the four compile lands in
`.bench-tmp/`.
