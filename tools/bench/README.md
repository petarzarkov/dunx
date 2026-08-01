# @dunx/bench

A benchmark harness comparing `@dunx/http` with other backend frameworks and
runtimes. Private workspace, never published.

The point of this harness is not that dunx wins. The single most useful number it
produces is the gap between `@dunx/http` and **raw `Bun.serve`**, because dunx is a
layer on top of that exact API — the gap is dunx's own overhead and nothing else.
Everything below is written so that number, and the places dunx loses, are as hard
to hide as the places it wins.

```bash
bun run setup     # downloads oha into .bin/ (optional, but read "Load generator")
bun run start     # full suite: 8 subjects x 4 scenarios
bun run start --help
```

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
| Bun.serve (raw) | 138,112 | 750 | 0.437 | 0.883 | 100.0% |
| Elysia | 135,304 | 1,347 | 0.448 | 0.902 | 98.0% |
| **@dunx/http** | **134,259** | 3,446 | 0.450 | 0.907 | **97.2%** |
| Hono (Bun) | 108,707 | 5,829 | 0.560 | 1.121 | 78.7% |
| node:http (raw) | 54,080 | 1,737 | 1.133 | 2.245 | 39.2% |
| @dunx/http (+ request logging) | 53,374 | 1,560 | 1.112 | 2.170 | 38.6% |
| Fastify (Node) | 49,892 | 701 | 1.248 | 2.454 | 36.1% |
| Hono (Node) | 48,101 | 639 | 1.299 | 2.558 | 34.8% |
| Express (Node) | 27,724 | 1,101 | 2.292 | 2.766 | 20.1% |

**JSON** — `GET /json`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) | 130,858 | 3,741 | 0.461 | 0.931 | 100.0% |
| Elysia | 126,771 | 1,172 | 0.481 | 0.966 | 96.9% |
| **@dunx/http** | **124,749** | 2,581 | 0.485 | 0.976 | **95.3%** |
| Hono (Bun) | 94,094 | 735 | 0.646 | 1.293 | 71.9% |
| node:http (raw) | 52,227 | 407 | 1.187 | 2.349 | 39.9% |
| @dunx/http (+ request logging) | 50,628 | 2,046 | 1.200 | 2.321 | 38.7% |
| Fastify (Node) | 47,745 | 2,366 | 1.312 | 2.506 | 36.5% |
| Hono (Node) | 37,755 | 638 | 1.680 | 2.052 | 28.9% |
| Express (Node) | 27,802 | 1,194 | 2.229 | 3.691 | 21.2% |

**Path parameter** — `GET /params/42`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) | 127,350 | 3,991 | 0.465 | 0.963 | 100.0% |
| Elysia | 121,456 | 2,642 | 0.504 | 1.014 | 95.4% |
| **@dunx/http** | **120,543** | 1,589 | 0.500 | 1.014 | **94.7%** |
| Hono (Bun) | 85,592 | 1,395 | 0.702 | 1.398 | 67.2% |
| node:http (raw) | 51,170 | 2,104 | 1.245 | 2.361 | 40.2% |
| @dunx/http (+ request logging) | 50,956 | 607 | 1.176 | 2.330 | 40.0% |
| Fastify (Node) | 44,485 | 1,325 | 1.406 | 2.784 | 34.9% |
| Hono (Node) | 38,762 | 263 | 1.624 | 2.049 | 30.4% |
| Express (Node) | 27,033 | 242 | 2.329 | 2.617 | 21.2% |

**Body validation** — `POST /validate`

| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| ------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) | 83,758 | 920 | 0.737 | 1.475 | 100.0% |
| **@dunx/http** | **70,365** | 169 | 0.870 | 1.732 | **84.0%** |
| Elysia | 69,978 | 4,673 | 0.876 | 1.751 | 83.5% |
| Hono (Bun) | 48,231 | 1,461 | 1.245 | 2.407 | 57.6% |
| @dunx/http (+ request logging) | 37,675 | 765 | 1.605 | 3.176 | 45.0% |
| node:http (raw) | 31,948 | 956 | 1.957 | 3.773 | 38.1% |
| Fastify (Node) | 22,801 | 368 | 2.559 | 9.485 | 27.2% |
| Hono (Node) | 22,548 | 608 | 2.749 | 5.411 | 26.9% |
| Express (Node) | 17,667 | 671 | 3.557 | 6.803 | 21.1% |

**Startup** — cold process to first served request, 5 samples

| Subject | median ms | min ms | max ms |
| ------- | --------: | -----: | -----: |
| Bun.serve (raw) | 27.9 | 25.3 | 28.4 |
| Hono (Bun) | 34.0 | 32.5 | 36.8 |
| **@dunx/http** | **53.1** | 50.8 | 53.7 |
| @dunx/http (+ request logging) | 54.9 | 54.0 | 56.4 |
| Elysia | 58.2 | 56.2 | 61.1 |
| node:http (raw) | 72.2 | 68.6 | 73.3 |
| Hono (Node) | 88.3 | 87.3 | 91.1 |
| Express (Node) | 106.0 | 105.2 | 108.7 |
| Fastify (Node) | 133.6 | 132.2 | 137.5 |

### What these say, including where dunx loses

**The dunx tax over raw `Bun.serve`** — the number this harness exists to produce:

| Scenario | Bun.serve | @dunx/http | dunx costs |
| -------- | --------: | ---------: | ---------: |
| `plaintext` | 138,112 | 134,259 | −2.8% |
| `json` | 130,858 | 124,749 | −4.7% |
| `params` | 127,350 | 120,543 | −5.3% |
| `validate` | 83,758 | 70,365 | −16.0% |

**A figure at or above 100% is noise, not a win.** `@dunx/http` dispatches
*through* `Bun.serve`; it cannot serve a request faster than the API it calls. When
the two land within each other's standard deviation — which they now do on
`plaintext` — the honest reading is "no measurable overhead", not "faster than
`Bun.serve`". Differences under about 3% on this setup are noise.

**`dunx-logging` is the same app with `requestLogging` left at its default**, and
it is 40-45% of the baseline where `dunx` is 81-100%. That gap is one structured
line per request: `JSON.stringify` plus a `write`, inside an `AsyncLocalStorage`
scope. Nothing else in this table logs anything, which is why the two rows exist
separately — see "Why dunx appears twice".

**Validation is still the largest real overhead**, and it is where both Bun-native
frameworks pay: dunx and Elysia land within a percentage point of each other, both
around 82% of the baseline. That is `req.json()`, a Standard Schema `validate`
call and the error-mapping path. The raw subject hand-wires the same zod schema, so
the delta is plumbing, not the validator.

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
- Differences under about 3% are noise on this setup.

## Output

The stdout table is for humans. `results/latest.json` (or `--out <path>`) is for
machines — `tools/docs` reads it at build time and renders it as the site's
leading page, so it is the one file under `results/` that is committed rather
than gitignored. A checkout without it still builds; the page says there is no
run. Shape:

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
  src/
    index.ts          entrypoint
    cli.ts            flags
    run.ts            orchestration: startup, warmup, measured runs
    subject-process.ts  spawn, readiness, contract verification, stop
    build.ts          Bun.build transpile of the Node subjects
    scenarios.ts      the four workloads and their exact expected responses
    subjects.ts       the subject registry, including each one's handicaps
    loadgen/          oha adapter, Bun fetch driver, worker, histogram
    report.ts         the stdout table
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
