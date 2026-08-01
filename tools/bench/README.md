# @dunx/bench

A benchmark harness comparing `@dunx/http` with other backend frameworks and
runtimes. Private workspace, never published.

The point of this harness is not that dunx wins. The single most useful number it
produces is the gap between `@dunx/http` and **raw `Bun.serve`**, because dunx is a
layer on top of that exact API — the gap is dunx's own overhead and nothing else.
Everything below is written so that number, and the places dunx loses, are as hard
to hide as the places it wins.

```bash
bun run setup       # downloads oha into .bin/ (optional, but read "Load generator")
bun run start       # full suite: 9 subjects x 4 scenarios
bun run validation  # the validation-cost harness — see "Validation cost"
bun run start --help
```

Two harnesses, and they answer different questions. `start` compares frameworks with
the validator held constant. `validation` does the opposite: one framework at a time,
one step of work at a time, and every validator swapped through the same Standard
Schema seam — which is how the `validate` scenario's cost gets split into parsing,
the validator, and dunx.

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

- **Throughput** — requests per second, median of N runs, with the standard
  deviation across those runs.
- **Latency** — p50 and p99, medians across runs, as the load generator measured
  them.

And one thing per subject:

- **Startup** — cold process spawn to first served request, median of N samples.
  Polled at 1 ms, so treat anything under about 5 ms as a tie.

### Subjects

| Subject           | Runtime | Why it is here                                                                 |
| ----------------- | ------- | ------------------------------------------------------------------------------ |
| `bun-serve`       | Bun     | The ceiling. `@dunx/http` sits on this API; the gap is dunx overhead.          |
| `dunx`            | Bun     | `@dunx/http`, with the compiler preload and a constructor-injected dependency. |
| `dunx-logging`    | Bun     | The same app with `requestLogging` left at its default — see below.            |
| `elysia`          | Bun     | The other Bun-native framework.                                                |
| `hono-bun`        | Bun     | Hono on `Bun.serve`.                                                           |
| `hono-node`       | Node    | The *same* Hono app on `node:http`, so runtime can be separated from framework. |
| `node-http`       | Node    | The Node ceiling: a bare `requestListener`, no framework.                      |
| `fastify`         | Node    | The fast Node framework.                                                       |
| `express`         | Node    | The one everyone actually has in production.                                   |

Each subject is a single file under `servers/`, small enough to read in full. If a
number looks wrong, read the file — that is the whole implementation.

#### Why dunx appears twice

`@dunx/http` installs `RequestLoggingMiddleware` by default: one structured entry
per request. **No other subject in this suite logs anything.** Comparing a
framework that writes and flushes a line per request against seven that write
nothing measures the logger, not the framework — so the primary `dunx` subject
passes `requestLogging: false`, which is the apples-to-apples number.

The cost of the default is not swept under that: `dunx-logging` is the identical
app with the default left alone, in the same table, so both are visible. Read
`dunx` as "the framework" and `dunx-logging` as "the framework plus
out-of-the-box observability".

This split exists because measuring found the default was costing far more than
anyone had guessed — the response-body capture cloned and buffered every payload
on the hot path. That is now off by default, and the remaining gap between the two
rows is `JSON.stringify` plus a `write` per request, which is the irreducible
price of a log line.

### Deliberate handicaps, in both directions

These are choices that move the numbers. They are listed here rather than buried.

- **`bun-serve` uses route handlers, not static `Response` objects.** `Bun.serve`
  can serve a `Response` instance from a precomputed buffer, which is faster than
  anything a framework can do and measures nothing about frameworks. Using it would
  have inflated the ceiling dunx is measured against — flattering to nobody.
- **Every subject validates with zod**, including Fastify and Elysia, which ship
  faster compiled validators (ajv/JSON Schema and TypeBox). Holding the validator
  constant is what makes `validate` minus `json` readable as *that framework's
  validation plumbing*. It also **understates Fastify and Elysia** on that one
  scenario, and the JSON report records each subject's validator so this is visible.
- **Fastify sets no response schema**, so it serialises with `JSON.stringify` like
  everyone else rather than `fast-json-stringify`. This understates Fastify.
- **Express has `etag` and `x-powered-by` disabled.** Both are on by default and
  are work no other subject does. This flatters Express relative to its defaults.
- **dunx runs with the `@dunx/compiler` preload and a real injected dependency**,
  because that is how a dunx app is written. DI resolution happens at boot, so it
  lands in the startup number and not the per-request number.
- **No logging, no CORS, no middleware anywhere.** `@dunx/http` has none of these on
  by default; enabling them for other subjects and not dunx, or vice versa, would
  measure configuration rather than frameworks.

## What is not measured

- **Absolute capacity.** The generator and the subject share a machine, a scheduler
  and the loopback interface. These numbers rank subjects against each other on this
  box. They do not predict what any of them does behind a real network.
- **Concurrency beyond one process.** Every subject is single-process and
  single-threaded. No `reusePort`, no cluster, no worker pool. Real deployments scale
  out and the ranking may not survive that.
- **Anything with I/O.** No database, no cache, no filesystem, no upstream calls. In
  an application that talks to Postgres, all of these differences are rounding error
  next to one query. That is the honest framing for every result below.
- **Memory, and behaviour under sustained load.** Runs are seconds long. Nothing here
  says anything about heap growth or a leak at hour six.
- **TLS, HTTP/2, HTTP/3, websockets, streaming, large bodies, file uploads.**
- **Cold-start under a constrained CPU**, which is what actually matters on a
  serverless platform. The startup numbers here are from an idle 32-core desktop.

## Methodology

1. **Node subjects are transpiled first.** `Bun.build` emits ESM to `.bench-tmp/`
   with dependencies external, so Node loads the real express/fastify/hono from
   `node_modules`. This exists because Node's type stripper does not remap the `.js`
   import specifiers this repo requires, and older Node cannot run TypeScript at all.
2. **One fresh process per (subject, scenario).** The harness picks a free port,
   spawns the subject, waits for it to answer, and kills it afterwards. No scenario
   inherits another scenario's warmed-up JIT state or heap.
3. **Contract verification** before every measurement, as described above.
4. **Warmup.** A full unmeasured load run (default 3 s) precedes the measured runs
   for each scenario, so the measured window is against a JIT-warm server.
5. **Multiple runs.** Default 5 measured runs of 5 s each. The report gives the
   **median** and the **standard deviation** across runs, never a single run.
6. **Startup is measured separately**, by spawning and killing the subject N times
   (default 7) and timing spawn to first successful response.
7. **The machine is recorded** — CPU model, logical cores, RAM, kernel, arch, Bun
   version, Node version — along with every subject's package version, in both the
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

**It is not the bottleneck**, and that was checked rather than assumed. Driving one
`Bun.serve` process at 64 connections gives ~130k req/s. Driving four `Bun.serve`
processes with four oha instances at the same time gives **~385k req/s in total**. A
generator with 3x headroom over the fastest subject is not what is being measured.

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

It plateaus around **80k req/s** — roughly 60% of what oha extracts from the same
server — and above about 128 connections it collapses, because thirty JavaScript
worker threads contending on Bun's connection pool cost more than the server does.

So: the fetch driver is usable for a *relative ranking of the slower subjects* and
for smoke-testing the harness. It is not usable for the dunx-vs-`Bun.serve` gap,
which is the number this harness exists to produce. **Install oha for anything you
intend to quote.**

## Results

Generated from `results/latest.json` by `bun src/readme-tables.ts` — never
transcribed by hand.

```
AMD Ryzen 9 5950X 16-Core Processor, 32 logical cores, 62.7 GiB RAM
linux 7.0.0-28-generic x64 | bun 1.3.14 | node v24.13.1 | oha oha 1.15.0
64 connections | 3s warmup | 4 x 4s measured | 2026-08-01
dunx-logging 0.0.0 | elysia 1.4.29 | hono-bun 4.12.33 | hono-node 4.12.33 | fastify 5.11.0 | express 5.2.1
```

Reproduce with `bun run start`; the full JSON lands in `results/latest.json`.

**Plain text** — `GET /plaintext`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) | 116,941 | 1,494 | 0.518 | 1.043 | 100.0% |
| Elysia | 115,435 | 497 | 0.525 | 1.057 | 98.7% |
| **@dunx/http** | **114,133** | 1,459 | 0.527 | 1.061 | **97.6%** |
| Hono (Bun) | 91,829 | 2,355 | 0.663 | 1.318 | 78.5% |
| @dunx/http (+ request logging) | 48,756 | 1,512 | 1.217 | 2.383 | 41.7% |
| node:http (raw) | 48,175 | 871 | 1.283 | 2.547 | 41.2% |
| Fastify (Node) | 44,248 | 1,855 | 1.418 | 2.706 | 37.8% |
| Hono (Node) | 42,644 | 2,174 | 1.440 | 2.800 | 36.5% |
| Express (Node) | 27,244 | 934 | 2.271 | 2.973 | 23.3% |

**JSON** — `GET /json`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) | 115,031 | 1,263 | 0.526 | 1.057 | 100.0% |
| **@dunx/http** | **109,169** | 806 | 0.557 | 1.117 | **94.9%** |
| Elysia | 107,917 | 945 | 0.564 | 1.130 | 93.8% |
| Hono (Bun) | 75,941 | 4,303 | 0.815 | 1.628 | 66.0% |
| node:http (raw) | 46,552 | 108 | 1.339 | 2.664 | 40.5% |
| @dunx/http (+ request logging) | 46,157 | 1,834 | 1.291 | 2.526 | 40.1% |
| Fastify (Node) | 42,727 | 1,320 | 1.466 | 2.828 | 37.1% |
| Hono (Node) | 37,747 | 1,133 | 1.650 | 3.252 | 32.8% |
| Express (Node) | 26,462 | 659 | 2.365 | 4.646 | 23.0% |

**Path parameter** — `GET /params/42`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) | 112,362 | 2,475 | 0.540 | 1.083 | 100.0% |
| Elysia | 110,129 | 1,609 | 0.548 | 1.101 | 98.0% |
| **@dunx/http** | **104,456** | 2,398 | 0.577 | 1.159 | **93.0%** |
| Hono (Bun) | 76,382 | 273 | 0.799 | 1.588 | 68.0% |
| node:http (raw) | 47,642 | 988 | 1.312 | 2.611 | 42.4% |
| @dunx/http (+ request logging) | 44,374 | 2,380 | 1.339 | 2.634 | 39.5% |
| Fastify (Node) | 43,044 | 2,698 | 1.446 | 2.837 | 38.3% |
| Hono (Node) | 34,949 | 1,624 | 1.751 | 3.470 | 31.1% |
| Express (Node) | 25,073 | 579 | 2.506 | 3.992 | 22.3% |

**Body validation** — `POST /validate`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) | 76,593 | 2,564 | 0.787 | 1.568 | 100.0% |
| **@dunx/http** | **69,081** | 1,360 | 0.884 | 1.756 | **90.2%** |
| Elysia | 64,154 | 1,220 | 0.940 | 1.858 | 83.8% |
| Hono (Bun) | 47,110 | 416 | 1.305 | 2.577 | 61.5% |
| @dunx/http (+ request logging) | 36,833 | 145 | 1.651 | 3.195 | 48.1% |
| node:http (raw) | 32,426 | 1,100 | 1.925 | 3.831 | 42.3% |
| Fastify (Node) | 22,156 | 109 | 2.682 | 9.109 | 28.9% |
| Hono (Node) | 19,821 | 818 | 3.173 | 6.169 | 25.9% |
| Express (Node) | 17,447 | 258 | 3.602 | 6.903 | 22.8% |

**Startup** — cold process to first served request, 5 samples

| Subject | median ms | min ms | max ms |
| ------- | --------: | -----: | -----: |
| Bun.serve (raw) | 28.0 | 27.0 | 28.6 |
| Hono (Bun) | 32.8 | 32.5 | 33.6 |
| **@dunx/http** | **52.6** | 51.6 | 58.0 |
| @dunx/http (+ request logging) | 54.1 | 52.9 | 55.4 |
| Elysia | 59.9 | 57.8 | 60.1 |
| node:http (raw) | 70.2 | 67.0 | 73.5 |
| Hono (Node) | 88.3 | 86.2 | 89.7 |
| Express (Node) | 105.4 | 102.1 | 107.6 |
| Fastify (Node) | 136.0 | 129.5 | 137.6 |

### What these say, including where dunx loses

**The dunx tax over raw `Bun.serve`** — the number this harness exists to produce:

| Scenario | Bun.serve | @dunx/http | dunx costs |
| -------- | --------: | ---------: | ---------: |
| `plaintext` | 116,941 | 114,133 | −2.4% |
| `json` | 115,031 | 109,169 | −5.1% |
| `params` | 112,362 | 104,456 | −7.0% |
| `validate` | 76,593 | 69,081 | −9.8% |

**A figure at or above 100% is noise, not a win.** `@dunx/http` dispatches
*through* `Bun.serve`; it cannot serve a request faster than the API it calls. When
the two land within each other's standard deviation — which they now do on
`plaintext` — the honest reading is "no measurable overhead", not "faster than
`Bun.serve`". Differences under about 3% on this setup are noise.

**`dunx-logging` is the same app with `requestLogging` left at its default**, and it
lands at roughly 40-50% of the baseline where `dunx` is 90-100%. That gap is one
structured line per request: `JSON.stringify` plus a `write`, inside an
`AsyncLocalStorage` scope. Nothing else in this table logs anything, which is why the
two rows exist separately — see "Why dunx appears twice".

**Validation is still the largest absolute cost**, but most of it is not the
framework's and not the validator's. Splitting it took a second harness — see
"Validation cost" below — and the answer is that `req.json()` costs about 3 µs while
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
  nothing, and do not quote an absolute as capacity. Nothing external was competing —
  `oha` and the subject were the only things on the CPU — so this is the machine's own
  frequency behaviour, not contention.

## Validation cost

Generated from `results/validation.json` by `bun src/readme-tables.ts` — never
transcribed by hand. Reproduce with `bun run validation`.

The main suite above holds the validator constant at zod on purpose, which folds two
costs into one number: what parsing and validating cost *at all*, and what
`@dunx/http` adds on top. This section separates them.

```
AMD Ryzen 9 5950X 16-Core Processor, 32 logical cores | bun 1.3.14 | oha oha 1.15.0
64 connections | 3s warmup | 5 x 4s measured | 2026-08-01
```

**Every row is one fresh process, and the measured rounds are interleaved across all
of them** rather than run to completion one row at a time — the differences here are
2-4% and the machine drifts by more than that over a run. Read anything under about
**±0.3 µs** as unresolvable: that is what the run-to-run standard deviations work out
to at this throughput.

### Parsing costs more than validating

Four raw `Bun.serve` routes, each doing exactly one thing more than the one above
it, all answering the same bytes:

| Step | req/s | µs/req | this step adds |
| ---- | ----: | -----: | -------------: |
| `GET /json` — no request body at all | 113,881 | 8.78 | — |
| `POST`, body on the wire, never read | 110,537 | 9.05 | +0.27 µs |
| `POST` + `await req.json()` | 82,341 | 12.14 | +3.10 µs |
| `POST` + `req.json()` + zod | 76,412 | 13.09 | +0.94 µs |

**`req.json()` is the expensive step by a wide margin**, and putting the body on the
wire is near-free — the difference between *sending* it and *reading* it is what
costs. No framework can remove that, and no choice of validator affects it. The
primitive that would is a validating parser Bun does not ship; see
[`docs/bun-apis.md`](../../docs/bun-apis.md).

### Validators through the same Standard Schema seam

The same dunx app and the same schema shape, with only the library behind
`~standard` changed. **costs** is that validator's own time — the raw `Bun.serve`
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
choosing between them** — pick on API, error quality and ecosystem. If a profile
genuinely points at validation, the compiled route is there.

`noop` and `noop-async` are the last two rows and are not validators: `noop` is a
hand-written pass-through, which is dunx's plumbing with the validator's cost taken
out, and `noop-async` is the same thing behind a resolved promise — so the gap
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
| `@dunx/http`, `body` declared — the framework does it | 68,843 | 14.53 |

The two `manual` rows declare no schemas and do the work inside the handler, which
keeps them on the synchronous dispatch path — so they separate dunx's **dispatch**
cost from its **input reader** cost. Dispatch is the second row minus the first.

The reader is the fourth row minus the third, and it is now at or below zero: the
framework's reader costs no more than writing `validate(await req.json())` in the
handler yourself. It used to cost **2.05 µs more**, which was twice what zod itself
cost — the reason is in
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md), "The cost of request
validation".

## How the validation harness works

`bun run validation` spawns one process per row, exactly like `start`, and verifies
each one answers the same bytes before measuring it. There are two subject files:

- **`servers/validation/raw.ts`** — raw `Bun.serve`, four routes each doing one thing
  more than the last: `GET /json` (no body), `POST /discard` (body on the wire, never
  read), `POST /parse` (`await req.json()`), `POST /validate` (parse + validate). The
  differences between consecutive rows are the decomposition.
- **`servers/validation/dunx.ts`** — a dunx app with `POST /validate` (a declared
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
  no extra keys, so it does not show up here — it would on a wider payload.
- **`noop` and `noop-async` are not validators.** They are hand-written pass-through
  Standard Schemas, present to measure dunx's plumbing with the validator's cost
  removed, and to confirm that an async validator still works and what it costs.
- One payload, 69 bytes, three fields. Nothing here predicts a deeply nested schema,
  where the engines diverge much more than they do at this size.

## Output

The stdout table is for humans. `results/latest.json` (or `--out <path>`) is for
machines — `tools/docs` reads it at build time and renders it as the site's
leading page, so it is committed rather than gitignored. A checkout without it still
builds; the page says there is no run.

`results/validation.json` is the second committed artifact, written by
`bun run validation` and read by `src/validation-tables.ts` to render the
"Validation cost" section. Its shape is `ValidationReport` in `src/types.ts`. Nothing
outside this workspace reads it, and a checkout without it still regenerates the
rest of the README.

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
  "subjects": [{
    "id": "string", "label": "string", "runtime": "bun" | "node",
    "version": "string", "validator": "string",
    "notes": ["string"],              // the handicaps above, per subject
    "entry": "string", "preload": ["string"], "versionOf": "string | null"
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
  src/
    index.ts          entrypoint for the framework suite
    validation.ts     entrypoint for the validation harness
    cli.ts            flags
    run.ts            orchestration: startup, warmup, measured runs
    subject-process.ts  spawn, readiness, contract verification, stop
    build.ts          Bun.build transpile of the Node subjects
    scenarios.ts      the four workloads and their exact expected responses
    subjects.ts       the subject registry, including each one's handicaps
    loadgen/          oha adapter, Bun fetch driver, worker, histogram
    report.ts         the stdout table
    readme-tables.ts  regenerates both README results sections
    validation-tables.ts  the "Validation cost" section
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

Node subjects need nothing extra — `src/build.ts` finds them by `runtime: 'node'`.

## Requirements

- Bun (the harness itself, and the Bun subjects).
- Node **for the Node subjects only**. The harness uses `node` from `PATH`, or
  `$BENCH_NODE`. If neither resolves, it prints a line saying so, skips those
  subjects and still produces a report.
