# @dunx/bench

A benchmark harness comparing `@dunx/http` with other backend frameworks and
runtimes. Private workspace, never published.

The point of this harness is not that dunx wins. The single most useful number it
produces is the gap between `@dunx/http` and **raw `Bun.serve`**. dunx is a layer
on top of that exact API, so the gap is dunx's own overhead and nothing else.
Everything below is written so that number, and the places dunx loses, are as hard
to hide as the places it wins.

```bash
bun run setup       # downloads oha into .bin/ (optional, but read "Load generator")
bun run smoke       # does every subject start and answer every scenario? no load, no timing
bun run start       # full suite: 20 subjects x 5 scenarios, minus any whose toolchain is absent
bun run drivers     # Bun.SQL/Bun.RedisClient against pg/ioredis - see "Driver cost"
bun run validation  # the validation-cost harness - see "Validation cost"
bun run db-modes    # @dunx/infra/db async vs synchronous SQLite, end to end
bun run start --help
```

**Run `bun run smoke` first.** It starts every subject once per scenario and checks
the contract, with no load and no timing, so a subject that fails to build or
answers the wrong bytes says so in a couple of minutes rather than forty. It found
two real defects the day it was written: the .NET subjects refuse to start without
`DOTNET_PROCESSOR_COUNT=1`, and two Node subjects took themselves down on an
unhandled pool rejection.

Four measuring harnesses, and they answer different questions. `start` compares
frameworks with the validator held constant. `drivers` holds the framework, the
runtime and the server constant and swaps only the database and cache client, which
is the only way to separate "Bun's client is faster" from "Bun is faster".
`validation` swaps every validator through the same Standard Schema seam - which is
how the `validate` scenario's cost gets split into parsing, the validator, and dunx.
`db-modes` holds the framework, the SQL and the bytes on the wire constant, and
varies only whether the handler awaits its way to the row. It writes
`results/db-modes.json`, and what it found is recorded in
`docs/architecture/constraints.md` under "Synchronous SQLite mode".

## What is measured

Five scenarios, each implemented the same way in every subject:

| Scenario    | Request              | Response                          | What it adds                  |
| ----------- | -------------------- | --------------------------------- | ----------------------------- |
| `plaintext` | `GET /plaintext`     | `Hello, World!` as `text/plain`   | request/response dispatch     |
| `json`      | `GET /json`          | `{"message":"Hello, World!"}`     | + JSON serialisation          |
| `params`    | `GET /params/42`     | `{"id":"42"}`                     | + route matching with a param |
| `validate`  | `POST /validate`     | `{"name":"Ada Lovelace","age":36}` | + body parse and validation  |
| `io`        | `GET /io`            | `{"cached":"Hello, World!","id":1,...}` | + a Redis `GET` and a Postgres `SELECT` |

The first four are CPU and dispatch. `io` is the one that leaves the process: one
`GET bench:greeting` against Redis, then one
`SELECT id, memo, amount FROM bench_ledger WHERE id = $1` against Postgres with the
id **bound**, because a bound parameter is the prepare-and-bind path where clients
differ. Sequential, not concurrent - a cache read that gates a database read is the
shape the scenario is named for, and issuing both at once would measure the client's
concurrency primitives instead.

`io` needs Redis and Postgres. **It is opt-in on them answering**: the harness seeds
the fixture before anything is measured and drops the scenario with a line saying so
if either is absent, the same way a missing toolchain drops its subjects. See
"Running the io scenario".

Before any scenario is measured, the harness sends one request and asserts the
subject returned **the same status, the same body bytes and the same media type**
as the contract in `src/scenarios.ts`. A subject that answers differently is doing a
different amount of work, and the run fails rather than producing a number nobody
can compare. See `verifySubject` in `src/subject-process.ts`.

Four things are reported per subject and scenario:

- **Throughput** - requests per second, median of N runs, with the standard
  deviation across those runs.
- **Latency** - p50 and p99, medians across runs, as the load generator measured
  them.
- **Peak resident set** - the highest reading taken during the measured window, for
  the subject's **whole process tree**. `gunicorn` is a master and a worker, and
  charging Django only the master's 12 MiB would be wrong by the size of the thing
  actually serving.
- **CPU per request** - milliseconds of user plus system time per thousand requests.

And two things per subject:

- **Startup** - cold process spawn to first served request, median of N samples.
  Polled at 1 ms, so treat anything under about 5 ms as a tie.
- **Boot footprint** - resident set the moment the subject answered its first
  request, before any load. The only reading taken with nothing in flight.

### Memory and CPU, and how to read them

They come from `/proc/<pid>/stat` for every process in the tree, sampled at 20 Hz
inside the measured window and nowhere else. There is no `Bun.*` API for another
process's usage and no package involved: `pidusage` and friends shell out to `ps`
per sample, and the kernel already publishes the two numbers. `src/resources.ts`.

**`cpu ms/kreq` is the column to read, not `cpu %`.** Every subject here is one
thread under saturating load, so every percentage sits near 100 and ranks nothing.
CPU per request is what separates a subject that spends its time computing from one
that spends it waiting - which is why the `io` scenario is where it earns its place
and the `plaintext` scenario is where it is roughly the reciprocal of throughput.

**Peak RSS is the peak of the samples.** A collection that happens between two reads
is missed. 50 ms against a 5-second round is 100 readings, which finds a steady
state and will under-report a spike.

**Neither says anything about hour six.** Runs are seconds long, and nothing here is
a statement about heap growth or a leak.

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
its own floor. It is still 2.4x NestJS-on-Fastify and 1.6x Spring in absolute
throughput, because the floor it is paying that tax on is a different height.
`params` is where it costs most, which is route-value plus action-parameter model
binding rather than dispatch.

Both are `dotnet publish -c Release` and nothing else: no ReadyToRun, no Native
AOT, no trimming, no invariant globalization. Native AOT would take most of the
startup number away and is what a .NET benchmark usually ships; it is not what
`dotnet new webapi` gives anyone, and nothing else in this suite is tuned that way
either.

Neither row logs. ASP.NET Core's hosting layer writes two Information entries per
request by default, which is what the default template's `appsettings.json` turns
off. Both subjects do the same in the file you are reading, for the reason the
`dunx` and `dunx-logging` split exists.

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
rest of this table has ever measured. It is **not** what anyone deploying Go, Rust
or .NET actually gets. Measured on the machine below at the same 64
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
`aspnet-minimal` and `aspnet-mvc` get a 30-second unmeasured warmup instead. That
figure is recorded per subject in the report and printed above the tables.
Reporting a cold JVM would be exactly the kind of flattering measurement this file
exists to avoid, pointed the other way. .NET turned out to need it just as badly:
measured, `aspnet-minimal` served 40k req/s on the `json` scenario after a
3-second warmup, was still climbing 20 seconds later and plateaued near 88k.
Quoting the first number would have understated it by 2.2x.

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
- **The Node subjects run on the current LTS, and the version is in every report.**
  Nothing pins it - the harness takes whatever `node` or `$BENCH_NODE` resolves -
  so it is a choice the person taking the run makes, and the wrong choice quietly
  handicaps six of the twenty subjects.

  **It is worth more than anyone guessed.** The first run of the `io` scenario was
  taken on 20.20.2, out of maintenance, against a Bun on its current release. Both
  runs measured as a share of raw `Bun.serve`, so the machine cancels:

  | Subject | plaintext | json | params | validate | io |
  | ------- | --------: | ---: | -----: | -------: | -: |
  | Express | 9.2 -> 20.5 | 9.2 -> 20.3 | 9.3 -> 19.9 | 10.2 -> 19.2 | 23.8 -> 39.5 |
  | NestJS (Express) | 7.2 -> 14.6 | 7.0 -> 13.9 | 7.0 -> 13.6 | 8.2 -> 14.6 | 20.7 -> 35.8 |
  | node:http (raw) | 31.4 -> 39.7 | 31.6 -> 37.7 | 32.9 -> 36.9 | 33.0 -> 35.6 | 50.3 -> 51.5 |
  | Fastify | 28.5 -> 34.5 | 30.7 -> 34.0 | 30.4 -> 34.0 | 20.0 -> 25.1 | 49.2 -> 52.4 |
  | Hono (Node) | 28.2 -> 30.6 | 26.0 -> 28.5 | 24.0 -> 26.6 | 22.6 -> 22.5 | 44.3 -> 46.5 |
  | NestJS (Fastify) | 25.6 -> 27.6 | 26.0 -> 30.3 | 23.7 -> 26.6 | 17.2 -> 22.0 | 44.8 -> 47.4 |

  Express and Nest-on-Express roughly **doubled**; 29 of 30 cells improved. An
  out-of-date Node is not a small handicap on this suite, it is the largest single
  one a run can carry, and `machine.node` in the JSON and in the header above every
  table is what makes it checkable rather than a matter of trust.
- **The two Redis clients are left at defaults that differ.** `Bun.RedisClient`
  batches a tick's commands into one write; `ioredis` does not, because
  `enableAutoPipelining` is `false` in 6.0.0. Neither is changed, for the reason
  `uvicorn[standard]` is not installed: defaults are what the comparison is of.
  The subject registry records which is which, and "Driver cost" reads the pair.
- **Every `io` pool is pinned to 8**, including the ones whose default is larger.
  With 64 connections against one worker thread the pool is what sets how many
  queries are in flight, so a subject on its own default would be measured on its
  configuration. The clients that multiplex one connection instead of pooling -
  `Bun.RedisClient`, `ioredis`, StackExchange.Redis, Lettuce, redis-rs - are
  recorded as doing so, per subject, in `results/latest.json`.
- **The `io` clients are not held constant across languages**, and cannot be, for
  the same reason the validators are not. Each subject uses its ecosystem's choice:
  `Bun.SQL`/`Bun.RedisClient`, `pg`/`ioredis`, pgx/go-redis, tokio-postgres/redis-rs,
  HikariCP/Lettuce, Npgsql/StackExchange.Redis, psycopg/redis-py. Compare an `io` row
  to its own `json` row before comparing it across languages, and read "Driver cost"
  for the one comparison where the client is the only thing that changes.

### Blocking subjects on the io scenario

**`spring` and `django` are the two blocking stacks, and one worker thread means one
request in flight for the whole round trip.** JDBC, Lettuce's synchronous commands,
psycopg and redis-py all park the worker until the server answers. Every other
subject is async and has eight queries in flight against the same pool.

This is the thread pinning meaning something different on `io` than it does on the
other four. On `plaintext` "one thread" is the same handicap for everybody, because
everybody is computing. On `io` it caps a blocking stack's concurrency at one and an
async stack's at its pool size, and the gap between those two numbers is in the
result.

It is left as it is rather than given the blocking subjects eight threads, because
every table in this file rests on "every subject is one process on one thread" and
forking that per scenario would need re-justifying all of them. So: read `spring`
against `django`, and read either against its own `json` row. Do not read either as
what a Spring or Django deployment does, which runs many workers.

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
- **Anything with I/O, on the first four scenarios.** No database, no cache, no
  filesystem, no upstream calls. In an application that talks to Postgres, all of
  those differences are rounding error next to one query. That used to be an
  assertion in this paragraph and is now the `io` row, which measures it - see "The
  framework tax disappears on `io`" under the results.
- **The filesystem, and upstream HTTP.** `io` reaches Redis and Postgres and nothing
  else.
- **Behaviour under sustained load.** Runs are seconds long. Peak resident set is
  reported per round; nothing here says anything about heap growth or a leak at hour
  six.
- **TLS, HTTP/2, HTTP/3, websockets, streaming, large bodies, file uploads.**
- **Cold-start under a constrained CPU**, which is what actually matters on a
  serverless platform. The startup numbers here are from an idle 32-core desktop.

## Running the io scenario

Two services, and the harness seeds both before anything is measured. A subject
must not seed its own fixture, or two subjects could be reading different rows.

| Variable            | Default                                    |
| ------------------- | ------------------------------------------ |
| `$BENCH_REDIS_URL`  | `redis://127.0.0.1:6379`                   |
| `$BENCH_PG_URL`     | `postgres://dunx:dunx@127.0.0.1:5432/dunx` |

```bash
docker run -d --name bench-valkey -p 6379:6379 valkey/valkey:8-alpine
docker run -d --name bench-pg -p 5432:5432 \
  -e POSTGRES_USER=dunx -e POSTGRES_PASSWORD=dunx -e POSTGRES_DB=dunx \
  postgres:17-alpine -c max_connections=200
```

**`max_connections=200` is not decoration, and this is the scenario's hardest
precondition.** Measured rounds are interleaved, so every subject is up and pooled
at the same time: twenty subjects at a pool of 8 want 160 connections against
Postgres' default of 100. What that produced was not an error, it was a table. Two
Node subjects died of an unhandled pool rejection and were recorded at **560,964
req/s of pure connection failures, sorted above raw `Bun.serve`**; four more served
5xx for a fifth of their requests; every one of those rows had a number in it.

Two things came out of that and both are in the code. The harness now reads
`SHOW max_connections` before the run and drops the `io` scenario with the figure to
set if the budget does not fit, and a row with any error or non-2xx is sorted last
and shown with no ratio. `src/io-fixture.ts` and `src/report.ts`.

The seed is 500 rows in `bench_ledger` and one Redis key, written with `Bun.SQL` and
`Bun.RedisClient`, so the harness needs no driver of its own.

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
linux 7.0.0-31-generic x64 | bun 1.4.2 | node v24.21.0 | oha oha 1.15.0
64 connections | 3s warmup | 5 x 5s measured | 2026-09-09
dunx-logging 3.5.1 | dunx-logging-arkv 3.5.1 | elysia 1.4.29 | nest-express 11.1.28 | nest-fastify 11.1.28 | hono-bun 4.12.33 | hono-node 4.12.33 | fastify 5.11.0 | express 5.2.1 | gin v1.12.0 | axum 0.8.9 | spring 4.1.0 | aspnet-minimal net10.0 | aspnet-mvc net10.0 | django 6.1 | fastapi 0.141.1
```

Reproduce with `bun run start`; the full JSON lands in `results/latest.json`.

**Plain text** - `GET /plaintext`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | peak MiB | cpu ms/kreq | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------: | ----------: | -------------: |
| Bun.serve (raw) | 134,478 | 514 | 0.453 | 0.914 | 47.1 | 7.70 | 100.0% |
| **@dunx/http** | **133,993** | 1,203 | 0.458 | 0.921 | 61.5 | 7.76 | **99.6%** |
| Elysia | 133,151 | 1,698 | 0.459 | 0.930 | 54.8 | 7.88 | 99.0% |
| Axum (Rust) | 126,969 | 1,202 | 0.499 | 0.553 | 4.8 | 7.89 | 94.4% |
| Hono (Bun) | 123,815 | 2,455 | 0.495 | 0.999 | 52.5 | 8.44 | 92.1% |
| ASP.NET Core minimal APIs | 110,649 | 2,356 | 0.558 | 0.803 | 98.8 | 11.32 | 82.3% |
| ASP.NET Core MVC | 88,702 | 1,311 | 0.697 | 0.982 | 104.4 | 13.57 | 66.0% |
| @dunx/http (+ request logging) | 80,618 | 594 | 0.761 | 1.507 | 69.6 | 13.19 | 59.9% |
| Gin (Go) | 76,480 | 418 | 0.831 | 1.910 | 22.5 | 13.09 | 56.9% |
| net/http (Go) | 74,976 | 423 | 0.851 | 1.867 | 17.9 | 13.36 | 55.8% |
| @dunx/http (+ request logging, @arkv/logger) | 59,967 | 1,230 | 1.000 | 1.991 | 76.3 | 17.57 | 44.6% |
| node:http (raw) | 53,325 | 814 | 1.162 | 2.295 | 86.1 | 18.81 | 39.7% |
| Spring Boot (JVM) | 52,073 | 77 | 1.205 | 1.721 | 352.3 | 28.79 | 38.7% |
| Fastify (Node) | 46,443 | 1,456 | 1.355 | 1.814 | 92.9 | 22.12 | 34.5% |
| Hono (Node) | 41,201 | 1,251 | 1.538 | 1.943 | 89.4 | 24.55 | 30.6% |
| NestJS (Fastify) | 37,178 | 1,864 | 1.623 | 2.173 | 109.4 | 27.85 | 27.6% |
| Express (Node) | 27,561 | 768 | 2.275 | 2.735 | 92.7 | 36.77 | 20.5% |
| NestJS (Express) | 19,640 | 256 | 3.145 | 3.573 | 109.6 | 51.99 | 14.6% |
| FastAPI (Python) | 7,321 | 71 | 8.725 | 9.012 | 44.1 | 136.34 | 5.4% |
| Django (Python) | 4,538 | 18 | 14.022 | 15.308 | 73.6 | 220.01 | 3.4% |

**JSON** - `GET /json`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | peak MiB | cpu ms/kreq | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------: | ----------: | -------------: |
| Bun.serve (raw) | 129,641 | 1,354 | 0.470 | 0.944 | 46.3 | 7.96 | 100.0% |
| Axum (Rust) | 126,805 | 644 | 0.500 | 0.574 | 4.8 | 7.89 | 97.8% |
| **@dunx/http** | **123,999** | 1,618 | 0.493 | 0.990 | 60.3 | 8.33 | **95.6%** |
| Elysia | 122,220 | 1,094 | 0.501 | 1.010 | 55.5 | 8.59 | 94.3% |
| Hono (Bun) | 112,717 | 1,624 | 0.544 | 1.095 | 54.9 | 9.29 | 86.9% |
| ASP.NET Core minimal APIs | 105,833 | 1,356 | 0.590 | 0.795 | 102.2 | 11.90 | 81.6% |
| ASP.NET Core MVC | 84,393 | 1,744 | 0.734 | 1.016 | 106.7 | 14.14 | 65.1% |
| @dunx/http (+ request logging) | 77,015 | 991 | 0.791 | 1.561 | 68.0 | 13.84 | 59.4% |
| Gin (Go) | 74,874 | 866 | 0.850 | 1.955 | 22.4 | 13.37 | 57.8% |
| net/http (Go) | 74,363 | 312 | 0.859 | 1.887 | 17.9 | 13.46 | 57.4% |
| @dunx/http (+ request logging, @arkv/logger) | 58,051 | 828 | 1.046 | 2.082 | 70.3 | 18.33 | 44.8% |
| Spring Boot (JVM) | 51,229 | 186 | 1.233 | 1.464 | 600.9 | 28.90 | 39.5% |
| node:http (raw) | 48,882 | 1,811 | 1.285 | 2.502 | 86.2 | 20.53 | 37.7% |
| Fastify (Node) | 44,040 | 1,505 | 1.392 | 1.843 | 92.1 | 23.37 | 34.0% |
| NestJS (Fastify) | 39,254 | 1,152 | 1.577 | 2.458 | 109.7 | 26.32 | 30.3% |
| Hono (Node) | 36,916 | 863 | 1.686 | 2.075 | 92.0 | 27.99 | 28.5% |
| Express (Node) | 26,275 | 240 | 2.385 | 2.644 | 92.7 | 38.41 | 20.3% |
| NestJS (Express) | 17,974 | 491 | 3.539 | 4.022 | 107.4 | 57.02 | 13.9% |
| FastAPI (Python) | 7,258 | 22 | 8.802 | 9.061 | 44.0 | 137.71 | 5.6% |
| Django (Python) | 4,425 | 45 | 14.389 | 16.098 | 73.9 | 225.74 | 3.4% |

**Path parameter** - `GET /params/42`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | peak MiB | cpu ms/kreq | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------: | ----------: | -------------: |
| Bun.serve (raw) | 128,172 | 1,199 | 0.478 | 0.961 | 47.9 | 8.06 | 100.0% |
| Elysia | 127,701 | 1,358 | 0.482 | 0.974 | 56.4 | 8.20 | 99.6% |
| Axum (Rust) | 122,718 | 880 | 0.514 | 0.633 | 4.8 | 8.14 | 95.7% |
| **@dunx/http** | **120,942** | 2,130 | 0.498 | 1.007 | 61.5 | 8.58 | **94.4%** |
| Hono (Bun) | 108,669 | 1,434 | 0.564 | 1.133 | 54.1 | 9.66 | 84.8% |
| ASP.NET Core minimal APIs | 105,077 | 2,309 | 0.596 | 0.819 | 99.9 | 11.83 | 82.0% |
| @dunx/http (+ request logging) | 75,577 | 1,144 | 0.807 | 1.600 | 69.5 | 14.12 | 59.0% |
| Gin (Go) | 74,708 | 415 | 0.850 | 1.969 | 22.5 | 13.40 | 58.3% |
| net/http (Go) | 73,448 | 838 | 0.870 | 1.897 | 17.6 | 13.62 | 57.3% |
| ASP.NET Core MVC | 68,123 | 1,740 | 0.903 | 1.240 | 105.9 | 17.24 | 53.1% |
| @dunx/http (+ request logging, @arkv/logger) | 56,899 | 1,301 | 1.074 | 2.144 | 64.7 | 18.75 | 44.4% |
| node:http (raw) | 47,348 | 1,560 | 1.355 | 2.476 | 86.0 | 21.24 | 36.9% |
| Spring Boot (JVM) | 44,459 | 1,014 | 1.414 | 1.769 | 628.8 | 33.03 | 34.7% |
| Fastify (Node) | 43,568 | 699 | 1.422 | 1.930 | 92.2 | 23.45 | 34.0% |
| NestJS (Fastify) | 34,110 | 490 | 1.806 | 2.242 | 109.0 | 30.22 | 26.6% |
| Hono (Node) | 34,043 | 1,096 | 1.809 | 2.324 | 93.9 | 30.34 | 26.6% |
| Express (Node) | 25,443 | 422 | 2.456 | 2.927 | 91.2 | 39.95 | 19.9% |
| NestJS (Express) | 17,446 | 446 | 3.637 | 4.086 | 108.3 | 57.98 | 13.6% |
| FastAPI (Python) | 6,677 | 55 | 9.549 | 9.996 | 43.3 | 149.78 | 5.2% |
| Django (Python) | 4,363 | 84 | 14.508 | 15.838 | 72.5 | 228.91 | 3.4% |

**Body validation** - `POST /validate`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | peak MiB | cpu ms/kreq | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------: | ----------: | -------------: |
| Bun.serve (raw) | 90,015 | 892 | 0.687 | 1.369 | 51.0 | 11.53 | 100.0% |
| Axum (Rust) | 84,320 | 3,397 | 0.758 | 0.812 | 5.5 | 11.86 | 93.7% |
| **@dunx/http** | **82,903** | 1,551 | 0.727 | 1.460 | 68.2 | 12.58 | **92.1%** |
| Elysia | 80,372 | 1,074 | 0.757 | 1.520 | 57.2 | 13.21 | 89.3% |
| ASP.NET Core minimal APIs | 77,560 | 2,309 | 0.798 | 1.097 | 101.9 | 15.26 | 86.2% |
| Hono (Bun) | 66,288 | 1,585 | 0.912 | 1.819 | 55.7 | 15.95 | 73.6% |
| @dunx/http (+ request logging) | 57,602 | 889 | 1.060 | 1.979 | 73.0 | 18.49 | 64.0% |
| ASP.NET Core MVC | 53,127 | 976 | 1.169 | 1.614 | 107.3 | 21.18 | 59.0% |
| Gin (Go) | 50,459 | 70 | 1.269 | 2.826 | 22.5 | 19.88 | 56.1% |
| net/http (Go) | 49,884 | 346 | 1.288 | 2.773 | 17.2 | 20.07 | 55.4% |
| @dunx/http (+ request logging, @arkv/logger) | 43,607 | 1,287 | 1.390 | 2.718 | 71.0 | 24.52 | 48.4% |
| Spring Boot (JVM) | 33,944 | 561 | 1.829 | 2.233 | 635.0 | 41.42 | 37.7% |
| node:http (raw) | 32,013 | 1,364 | 1.888 | 3.734 | 90.4 | 31.84 | 35.6% |
| Fastify (Node) | 22,584 | 403 | 2.620 | 9.675 | 258.6 | 52.47 | 25.1% |
| Hono (Node) | 20,225 | 918 | 3.096 | 5.751 | 105.7 | 49.70 | 22.5% |
| NestJS (Fastify) | 19,788 | 474 | 3.064 | 7.645 | 278.1 | 58.25 | 22.0% |
| Express (Node) | 17,312 | 441 | 3.642 | 4.401 | 97.4 | 58.17 | 19.2% |
| NestJS (Express) | 13,122 | 280 | 4.815 | 5.479 | 115.0 | 77.17 | 14.6% |
| FastAPI (Python) | 4,403 | 23 | 14.502 | 14.887 | 44.2 | 227.13 | 4.9% |
| Django (Python) | 4,199 | 61 | 15.132 | 16.780 | 73.8 | 237.85 | 4.7% |

**Cache and database** - `GET /io`, one Redis `GET` then one Postgres `SELECT`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | peak MiB | cpu ms/kreq | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------: | ----------: | -------------: |
| Axum (Rust) | 35,228 | 246 | 1.810 | 2.094 | 6.1 | 28.36 | 127.1% |
| Elysia | 27,741 | 248 | 2.296 | 3.516 | 66.3 | 38.41 | 100.1% |
| Bun.serve (raw) | 27,721 | 191 | 2.308 | 3.524 | 60.5 | 38.26 | 100.0% |
| **@dunx/http** | **27,646** | 347 | 2.305 | 3.597 | 71.9 | 38.74 | **99.7%** |
| Hono (Bun) | 26,494 | 518 | 2.406 | 3.782 | 64.1 | 40.69 | 95.6% |
| @dunx/http (+ request logging) | 24,734 | 363 | 2.553 | 4.188 | 78.2 | 44.35 | 89.2% |
| @dunx/http (+ request logging, @arkv/logger) | 22,517 | 111 | 2.838 | 4.494 | 80.6 | 47.83 | 81.2% |
| ASP.NET Core minimal APIs | 21,355 | 261 | 2.963 | 3.940 | 122.7 | 68.45 | 77.0% |
| Gin (Go) | 20,945 | 254 | 2.964 | 4.355 | 28.1 | 47.71 | 75.6% |
| net/http (Go) | 20,764 | 239 | 2.995 | 4.318 | 23.1 | 48.12 | 74.9% |
| ASP.NET Core MVC | 18,623 | 137 | 3.391 | 4.658 | 129.0 | 77.24 | 67.2% |
| Fastify (Node) | 14,520 | 415 | 4.323 | 5.881 | 121.8 | 70.54 | 52.4% |
| node:http (raw) | 14,267 | 612 | 4.317 | 6.040 | 113.2 | 72.12 | 51.5% |
| NestJS (Fastify) | 13,140 | 383 | 4.736 | 6.671 | 158.3 | 77.79 | 47.4% |
| Hono (Node) | 12,899 | 424 | 4.804 | 6.422 | 145.5 | 79.13 | 46.5% |
| Express (Node) | 10,959 | 432 | 5.679 | 7.670 | 130.0 | 93.11 | 39.5% |
| NestJS (Express) | 9,911 | 239 | 6.237 | 8.331 | 159.9 | 103.76 | 35.8% |
| Spring Boot (JVM) | 4,944 | 44 | 12.898 | 14.341 | 367.8 | 109.19 | 17.8% |
| FastAPI (Python) | 2,130 | 14 | 29.085 | 45.828 | 64.6 | 469.69 | 7.7% |
| Django (Python) | 1,580 | 21 | 40.461 | 43.469 | 104.9 | 441.49 | 5.7% |

Each subject uses its own ecosystem's clients, every pool pinned to 8 - the
`SUBJECTS` block in `results/latest.json` names the pair behind each row. `spring`
and `django` are blocking stacks and their one worker means one request in flight;
see "Blocking subjects on the io scenario". For the client comparison with the
runtime held still, see "Driver cost".

**Startup** - cold process to first served request, 7 samples

| Subject | median ms | min ms | max ms |
| ------- | --------: | -----: | -----: |
| Axum (Rust) | 1.7 | 1.6 | 1.9 |
| net/http (Go) | 4.0 | 3.8 | 4.3 |
| Gin (Go) | 5.0 | 4.1 | 5.3 |
| Bun.serve (raw) | 24.0 | 22.5 | 25.1 |
| Hono (Bun) | 27.4 | 26.3 | 28.8 |
| **@dunx/http** | **46.2** | 43.2 | 47.1 |
| @dunx/http (+ request logging) | 46.6 | 44.6 | 48.1 |
| Elysia | 51.9 | 49.0 | 57.0 |
| @dunx/http (+ request logging, @arkv/logger) | 61.4 | 55.8 | 63.4 |
| node:http (raw) | 80.7 | 76.3 | 83.3 |
| Hono (Node) | 95.5 | 90.2 | 97.9 |
| Express (Node) | 110.1 | 108.4 | 115.0 |
| Django (Python) | 131.4 | 128.0 | 132.8 |
| Fastify (Node) | 135.4 | 131.2 | 138.3 |
| NestJS (Express) | 243.7 | 231.0 | 258.2 |
| FastAPI (Python) | 244.0 | 239.9 | 245.6 |
| NestJS (Fastify) | 251.8 | 246.1 | 261.4 |
| ASP.NET Core MVC | 297.8 | 292.1 | 305.9 |
| ASP.NET Core minimal APIs | 299.6 | 281.2 | 312.9 |
| Spring Boot (JVM) | 1322.5 | 1274.7 | 1358.0 |

**Resource footprint** - resident set of the whole process tree, read from `/proc`

| Subject | boot MiB | peak MiB | processes |
| ------- | -------: | -------: | --------: |
| Axum (Rust) | 3.5 | 6.1 | 1 |
| net/http (Go) | 12.4 | 23.3 | 1 |
| Gin (Go) | 17.5 | 28.4 | 1 |
| Bun.serve (raw) | 34.6 | 62.8 | 1 |
| FastAPI (Python) | 43.0 | 64.6 | 1 |
| Hono (Bun) | 36.6 | 66.5 | 1 |
| Elysia | 47.2 | 68.9 | 1 |
| **@dunx/http** | 51.3 | 72.6 | 1 |
| @dunx/http (+ request logging) | 52.1 | 79.2 | 1 |
| @dunx/http (+ request logging, @arkv/logger) | 54.8 | 85.8 | 1 |
| Django (Python) | 73.5 | 104.9 | 2 |
| ASP.NET Core minimal APIs | 76.4 | 123.4 | 1 |
| ASP.NET Core MVC | 80.6 | 129.8 | 1 |
| node:http (raw) | 72.6 | 137.8 | 1 |
| Express (Node) | 73.7 | 139.6 | 1 |
| Hono (Node) | 77.2 | 148.4 | 1 |
| NestJS (Express) | 99.0 | 181.6 | 1 |
| Fastify (Node) | 79.1 | 269.1 | 1 |
| NestJS (Fastify) | 99.3 | 278.4 | 1 |
| Spring Boot (JVM) | 259.2 | 635.0 | 1 |

### What these say, including where dunx loses

**The dunx tax over raw `Bun.serve`** - the number this harness exists to produce:

| Scenario | Bun.serve | @dunx/http | dunx costs |
| -------- | --------: | ---------: | ---------: |
| `plaintext` | 134,478 | 133,993 | −0.4% |
| `json` | 129,641 | 123,999 | −4.4% |
| `params` | 128,172 | 120,942 | −5.6% |
| `validate` | 90,015 | 82,903 | −7.9% |
| `io` | 27,721 | 27,646 | −0.3% |

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

**Memory is the second one.** `@dunx/http` boots at 51.3 MiB against
raw `Bun.serve`'s 34.6 MiB, for the container and the resolved
provider graph, and the gap holds under load. It is small next to the Node subjects
and tiny next to `spring`, and it is still a cost the ceiling does not pay.

**The framework tax disappears on `io`, and that is the most useful thing in this
file.** dunx and raw `Bun.serve` land at 27,646 and 27,721 req/s,
inside each other's spread, where on `plaintext` the same two are
133,993 and
134,478. One Redis
round trip and one Postgres query cost more than every framework difference above
them put together. This file used to assert that under "What is not measured"; it is
now measured, and it is the number to quote at anyone choosing a framework on a
dispatch benchmark.

**CPU per request is the rate read from the other side.** On `plaintext` dunx
spends 7.76 ms per thousand requests against the
baseline's 7.70, which is the same gap the
throughput column shows. On `io` dunx and the baseline both sit near
38.26 while Axum spends 28.36: the
JavaScript subjects burn CPU that Rust does not, on a workload where it buys
neither of them any throughput, because both are waiting on the same two sockets.

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
- **`bad`** counts non-2xx responses plus transport errors across all measured runs,
  and it is judged as a **rate**, not a count. Above one in a thousand the row is
  sorted last and shown with no ratio; at or under it the row ranks normally and the
  count is still printed. The count alone was the rule until it was enforced and
  turned out to be wrong in both directions at once: two Node subjects that died
  mid-run were recorded at 560,964 req/s of pure connection failures and sorted
  above raw `Bun.serve`, while Django lost its ratio over **one** non-2xx in 38,909
  - 0.0026% - which reads as a broken measurement rather than a measurement with a
  blip in it. `src/quality.ts` owns the threshold, and the stdout table, the tables
  below and the documentation site all read it from there.
- **`cpu ms/kreq` before `peak MiB`.** CPU per request separates a subject that
  computes from one that waits; peak resident set is a footprint and moves with the
  runtime's allocator far more than with the framework. `cpu %` is not in the tables
  because every subject saturates one thread and every figure would read near 100.
- **On `io`, compare each row to its own `json` row first.** The clients differ per
  language and the two blocking subjects are capped at one request in flight. For
  the client comparison with everything else held still, read "Driver cost".
- **Differences under about 3 points are noise on this setup, and that was measured
  rather than assumed.** Two full runs on the same idle machine, same code, moved
  `@dunx/http`'s `vs bun-serve` figure by up to **3.2 points** (`params` 96.2% ->
  93.0%) while the baseline's own absolute throughput moved by up to **7.7%**
  (`json` 106,817 -> 115,031 req/s). So: read a gap of 5+ points as signal, read 2 as
  nothing, and do not quote an absolute as capacity. Nothing external was competing -
  `oha` and the subject were the only things on the CPU - so this is the machine's own
  frequency behaviour, not contention.

## Driver cost

What Bun's own database and cache clients are worth against the two a Node service
reaches for. Generated from `results/drivers.json` by `bun src/readme-tables.ts`.

The `io` scenario in the main table cannot answer this. Its Bun subjects run
`Bun.SQL` and `Bun.RedisClient` and its Node subjects run `pg` and `ioredis`, so
every gap there is a driver difference **and** a runtime difference. So this harness
runs `pg` and `ioredis` **on Bun**, next to the native pair on the same runtime, the
same `Bun.serve`, the same SQL, the same pool of 8 and the same bytes on the wire.

```
AMD Ryzen 9 5950X 16-Core Processor, 32 logical cores, 62.7 GiB RAM
linux 7.0.0-31-generic x64 | bun 1.4.2 | node v24.21.0 | oha oha 1.15.0
64 connections | 3s warmup | 5 x 5s measured | 2026-09-09
```

| Cell | Runtime | Postgres | Redis | req/s | stddev | p50 ms | peak MiB | cpu ms/kreq | vs native |
| ---- | ------- | -------- | ----- | ----: | -----: | -----: | -------: | ----------: | --------: |
| `bun:native` | bun | Bun.SQL | Bun.RedisClient | 27,822 | 469 | 2.291 | 60.1 | 38.28 | +0.0% |
| `bun:pg` | bun | pg | Bun.RedisClient | 24,280 | 347 | 2.557 | 79.7 | 44.27 | −12.7% |
| `bun:ioredis` | bun | Bun.SQL | ioredis | 29,210 | 560 | 2.135 | 83.1 | 37.44 | +5.0% |
| `bun:classic` | bun | pg | ioredis | 22,700 | 946 | 2.734 | 85.0 | 47.16 | −18.4% |
| `node:classic` | node | pg | ioredis | 15,338 | 341 | 4.110 | 198.5 | 65.65 | −44.9% |

Reproduce with `bun run drivers`.

**Read the first four rows and then the fifth, separately.** The first four differ
only in the client, so their differences are the client. `node:classic` changes the
runtime and the server as well, and is the reference point rather than a term in the
comparison.

| Swap, same runtime and same server | with the other client native | with the other client classic |
| ---------------------------------- | ---------------------------: | ----------------------------: |
| `Bun.SQL` -> `pg` | −12.7% | −22.3% |
| `Bun.RedisClient` -> `ioredis` | +5.0% | −6.5% |

**The Postgres client is the term that resolves. The Redis client is not.** Swapping
`Bun.SQL` for `pg` costs in both pairings, by far more than the run-to-run spread,
which tops out here at 4.2%. Swapping `Bun.RedisClient` for
`ioredis` comes out **positive against `Bun.SQL` and negative against `pg`**. A
sign change is what an unresolvable difference looks like, so the statement this
supports is that the two Redis clients are the same speed on this workload - not
that either one wins. Both are at their defaults, and those defaults are not the
same: `Bun.RedisClient` batches a tick's commands into one write and `ioredis`
does not (`enableAutoPipelining` is `false` in 6.0.0). Tying anyway is the
result; tuning one of them would have been a different measurement.

**The runtime is a larger term than either client.** `pg` and `ioredis` on Bun
against the same two on Node is −32.4%, where
swapping both clients on one runtime is
−18.4%. Quote the first four rows for what the
native clients are worth; most of what a Bun service gains on this workload, it
gains before it picks a client.

## Validation cost

Generated from `results/validation.json` by `bun src/readme-tables.ts` - never
transcribed by hand. Reproduce with `bun run validation`.

The main suite above holds the validator constant at zod on purpose, which folds two
costs into one number: what parsing and validating cost *at all*, and what
`@dunx/http` adds on top. This section separates them.

```
AMD Ryzen 9 5950X 16-Core Processor, 32 logical cores | bun 1.4.1 | oha oha 1.15.0
64 connections | 3s warmup | 3 x 4s measured | 2026-09-05
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
| `GET /json` - no request body at all | 132,020 | 7.57 | - |
| `POST`, body on the wire, never read | 125,518 | 7.97 | +0.39 µs |
| `POST` + `await req.json()` | 97,214 | 10.29 | +2.32 µs |
| `POST` + `req.json()` + zod | 93,836 | 10.66 | +0.37 µs |

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
| typebox | 0.06 µs | 96,688 | 91,919 | 95.1% |
| ajv | 0.26 µs | 94,825 | 87,872 | 92.7% |
| zod | 0.37 µs | 93,836 | 85,119 | 90.7% |
| arktype | 0.61 µs | 91,758 | 86,610 | 94.4% |
| valibot | 0.92 µs | 89,200 | 83,762 | 93.9% |
| noop | -0.09 µs | 98,058 | 90,592 | 92.4% |
| noop-async | -0.03 µs | 97,489 | 88,405 | 90.7% |

The three schema libraries span about half a microsecond, which is at the edge of
what this harness resolves, and the compiled options sit below it at this payload
size. **Every one of them is cheaper than `req.json()`**, so there is no throughput
argument for choosing between them - pick on API, error quality and ecosystem. If a
profile genuinely points at validation, the compiled route is there.

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
| raw `Bun.serve`, parse in the handler | 97,214 | 10.29 |
| `@dunx/http`, no schemas, parse in the handler | 91,404 | 10.94 |
| `@dunx/http`, no schemas, validate in the handler | 85,011 | 11.76 |
| `@dunx/http`, `body` declared - the framework does it | 85,119 | 11.75 |

The two `manual` rows declare no schemas and do the work inside the handler, which
keeps them on the synchronous dispatch path - so they separate dunx's **dispatch**
cost from its **input reader** cost. Dispatch is the second row minus the first.

The reader is the fourth row minus the third, and it is now at or below zero: the
framework's reader costs no more than writing `validate(await req.json())` in the
handler yourself. It used to cost **2.05 µs more**, which was twice what zod itself
cost - the reason is in
[`docs/architecture/cost-of-validation.md`](../../docs/architecture/cost-of-validation.md).

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
AMD Ryzen 9 5950X 16-Core Processor, 32 logical cores | bun 1.4.1 | oha oha 1.15.0
64 connections | 3s warmup | 3 x 4s measured | 2026-09-05
```

**Measured round-robin across all rows**, for the reason the validation harness
records: the differences are a few percent and the machine drifts by more than that
over a run. Read anything under about **±0.5 µs** as unresolvable.

| Step | req/s | µs/req | this step adds | total |
| ---- | ----: | -----: | -------------: | ----: |
| `requestLogging: false` | 125,319 | 7.98 | - | - |
| one middleware that only calls `next()` | 120,290 | 8.31 | +0.33 µs | +0.33 µs |
| + the pathname sliced out of `req.url` | 115,531 | 8.66 | +0.34 µs | +0.68 µs |
| + `traceparent` and `user-agent` read | 106,859 | 9.36 | +0.70 µs | +1.38 µs |
| + `TraceContext.adopt` | 104,551 | 9.56 | +0.21 µs | +1.59 µs |
| + `runWithContext` around the handler | 98,827 | 10.12 | +0.55 µs | +2.14 µs |
| + `traceresponse` set on the response | 90,770 | 11.02 | +0.90 µs | +3.04 µs |
| + the real middleware, `Logger` discards | 91,157 | 10.97 | −0.05 µs | +2.99 µs |
| + `new Date().toISOString()` | 92,093 | 10.86 | −0.11 µs | +2.88 µs |
| + the entry and `JSON.stringify`, string dropped | 80,570 | 12.41 | +1.55 µs | +4.43 µs |
| batched instead - **the shipped default** | 76,101 | 13.14 | +0.73 µs | +5.16 µs |

Reading it: the middleware chain and `TraceContext.adopt` are at or below what
this harness can resolve. What costs is **building and serialising the entry**, the
`.then` that sets `traceresponse` on the response, the **first touch of
`req.headers`**, the `AsyncLocalStorage` scope - and, before it was batched, the
write. Read the total rather than a single row: six of the eleven steps sit inside
the harness's own resolution and one of them reads negative.

### The write, and the pipe nobody was reading

| Write | req/s | µs/req |
| ----- | ----: | -----: |
| batched, `/dev/null` | 76,101 | 13.14 |
| one `console.log` per entry, `/dev/null` | 70,524 | 14.18 |
| batched, into a pipe nobody reads | 76,092 | 13.14 |
| one per entry, into a pipe nobody reads | 57,434 | 17.41 |

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

`results/drivers.json` is the fourth, written by `bun run drivers` and read by
`src/drivers-tables.ts` for the "Driver cost" section.

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
    "runtime": "bun" | "node" | "go" | "rust" | "jvm" | "dotnet" | "python",
    "version": "string", "validator": "string",
    "io": "string",                   // the Postgres and Redis clients behind its io row
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
  "resources": [{                     // empty off Linux, where /proc does not answer
    "subject": "string",              // Subject.id
    "scenario": "string",             // Scenario.id
    "rssBootMiB": 0.0,                // after the first request, before any load
    "rssPeakMiB":  { "median": 0.0, "min": 0.0, "max": 0.0, "stddev": 0.0 },
    "rssMeanMiB":  { "median": 0.0, "min": 0.0, "max": 0.0, "stddev": 0.0 },
    "cpuPercent":  { "median": 0.0, "min": 0.0, "max": 0.0, "stddev": 0.0 },
    "cpuMsPerKiloRequests": { "median": 0.0, "min": 0.0, "max": 0.0, "stddev": 0.0 },
    "processes": 0                    // largest tree seen; gunicorn is 2
  }],
  "startup": [{
    "subject": "string", "samplesMs": [0.0], "medianMs": 0.0
  }]
}
```

`results` and `resources` are flat lists; join both on `subject` and `scenario`. A
`(subject, scenario)` pair missing from `results` was not run; one missing from
`resources` was run on a machine with no `/proc`.

## Layout

```
internal/bench/
  servers/            one file per subject, each readable end to end
    shared.ts         the payloads and the one zod schema every subject validates with
    io/               the io scenario's clients, one module per ecosystem
      contract.ts     the key, the SQL, the pool size and the payload shape
      bun.ts          Bun.SQL and Bun.RedisClient, for the Bun subjects
      node.ts         pg and ioredis, for the Node subjects
      lazy.ts         the await import() that keeps those two out of the other scenarios
    drivers/          the driver harness: one client pair per cell
      pair.ts         the four clients, chosen by environment
      bun.ts          Bun.serve, for the four Bun cells
      node.ts         node:http, for the reference cell
    validation/       the validation harness's two subjects
      raw.ts          raw Bun.serve, one route per step of the decomposition
      dunx.ts         the dunx app, declared and hand-written variants
      schemas.ts      the one schema shape in every library, dynamically imported
    logging/          the request-logging harness's one subject
      dunx.ts         the app, with the middleware truncated at $LOGGING_VARIANT
      variants.ts     the step list and the three stand-in Logger bindings
    python/           one file per Python subject
      app.py          Django on gunicorn
      fastapi_app.py  FastAPI on uvicorn
      bench_io.py     psycopg and redis-py, sync for Django and async for FastAPI
    go/               one Go module, one command per subject
      shared/         the payloads, the validator, and the io clients (pgx, go-redis)
      cmd/nethttp/    net/http and http.ServeMux, the Go floor
      cmd/gin/        Gin
    rust/             one Cargo package, one [[bin]] per subject
      src/axum.rs     Axum on tokio, single-threaded
      src/io.rs       tokio-postgres behind deadpool, redis-rs multiplexed
    java/             one Maven project
      src/main/java/bench/App.java   Spring Boot, MVC over Tomcat
      src/main/java/bench/Io.java    HikariCP and Lettuce, both blocking
    dotnet/           one solution-less directory, one project per subject
      Directory.Build.props          the target framework and where builds land
      shared/         the payloads, the validator, the thread pinning, Npgsql + StackExchange.Redis
      aspnet-minimal/ minimal APIs on Kestrel, the .NET floor
      aspnet-mvc/     the same server with MVC on top
  src/
    index.ts          entrypoint for the framework suite
    smoke.ts          does every subject start and answer? no load, no timing
    drivers.ts        entrypoint for the driver harness
    validation.ts     entrypoint for the validation harness
    logging.ts        entrypoint for the request-logging harness
    cli.ts            flags
    run.ts            orchestration: startup, warmup, measured runs
    driver.ts         the round-robin loop the four side harnesses share
    subject-process.ts  spawn, readiness, contract verification, stop
    resources.ts      resident set and CPU for a process tree, out of /proc
    io-fixture.ts     seeds Redis and Postgres, and checks the connection budget
    build.ts          Bun.build transpile of the Node subjects
    toolchains.ts     probe, compile and skip for the Go, Rust, JVM and .NET subjects
    quality.ts        when a row's failure rate makes it unrankable
    scenarios.ts      the five workloads and their exact expected responses
    subjects.ts       the subject registry, including each one's handicaps
    loadgen/          oha adapter, Bun fetch driver, worker, histogram
    report.ts         the stdout table
    readme-tables.ts  regenerates every generated README section
    drivers-tables.ts     the "Driver cost" section
    validation-tables.ts  the "Validation cost" section
    logging-tables.ts     the "Request logging cost" section
    machine.ts        CPU/RAM/OS/runtime/package versions
    stats.ts          median, stddev, spread
```

## Adding a subject

1. Write `servers/<name>.ts`. It must read `PORT` from the environment and answer all
   five scenarios with byte-identical responses. Copy `servers/hono.ts`.
2. Add an entry to `src/subjects.ts`, including a `validator` string, an `io` string
   naming the two clients it answers `/io` with, and a `notes` array naming anything
   that flatters or handicaps it.
3. `bun run smoke --subjects <name>`. The contract check will tell you what does not
   match, without waiting for a measured run.

**The `/io` route connects only when `$BENCH_IO_PG_URL` and `$BENCH_IO_REDIS_URL`
are both set**, which the harness passes for that scenario and no other. A subject
spawns fresh per scenario, so the other four must open no socket and pay no client
module load - the Node subjects reach `pg` and `ioredis` through an `await import()`
in `servers/io/lazy.ts` for exactly that reason, and `src/build.ts` transpiles them
with `splitting` on so the dynamic import stays one.

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
| Node, current LTS        | the six Node subjects    | `PATH`, or `$BENCH_NODE`         |
| Go 1.22+                 | `nethttp`, `gin`         | `PATH`, or `$BENCH_GO`           |
| Rust / Cargo             | `axum`                   | `PATH`, or `$BENCH_CARGO`        |
| JDK 21+ **and** Maven    | `spring`                 | `PATH`, or `$BENCH_JAVA` and `$BENCH_MVN` |
| .NET SDK 10+             | `aspnet-minimal`, `aspnet-mvc` | `PATH`, or `$BENCH_DOTNET`  |
| Python 3.10+, Django, gunicorn | `django`           | `PATH`, or `$BENCH_PYTHON`       |
| Python 3.10+, FastAPI, uvicorn | `fastapi`          | `PATH`, or `$BENCH_PYTHON`       |
| Redis **and** Postgres   | the `io` scenario, `bun run drivers` | `$BENCH_REDIS_URL`, `$BENCH_PG_URL` |

The `io` scenario also needs a client library per language, and unlike the rows
above those are declared rather than probed: `pg` and `ioredis` in this workspace's
`package.json`, pgx and go-redis in `servers/go/go.mod`, tokio-postgres and redis-rs
in `Cargo.toml`, HikariCP, the Postgres JDBC driver and Lettuce in `pom.xml`, Npgsql
and StackExchange.Redis in `shared/Shared.csproj`, and psycopg plus redis-py for
Python. A toolchain that resolves builds them; nothing extra is opt-in.

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
python3 -m pip install --target pylib django gunicorn 'fastapi[standard]' uvicorn \
  redis 'psycopg[binary,pool]'
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
