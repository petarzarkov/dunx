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

```
AMD Ryzen 9 5950X 16-Core, 32 logical cores, 62.7 GiB RAM
linux 7.0.0-28-generic x64 | bun 1.3.14 | node v24.13.1 | oha 1.15.0
64 connections | 3s warmup | 5 x 5s measured | 2026-08-01
elysia 1.4.29 | hono 4.12.33 | fastify 5.11.0 | express 5.2.1
```

Zero errors and zero non-2xx responses in every cell below. Reproduce with
`bun run start`; the full JSON lands in `results/latest.json`.

**Plain text** — `GET /plaintext`

| Subject         | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| --------------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) |        133,382 |  3,317 |  0.445 |  0.929 |         100.0% |
| Elysia          |        129,088 |  3,544 |  0.455 |  0.998 |          96.8% |
| **@dunx/http**  |    **123,493** |  2,876 |  0.491 |  0.990 |      **92.6%** |
| Hono (Bun)      |        101,667 |  3,604 |  0.607 |  1.224 |          76.2% |
| node:http (raw) |         50,553 |  2,250 |  1.281 |  2.289 |          37.9% |
| Fastify (Node)  |         44,115 |    729 |  1.423 |  2.126 |          33.1% |
| Hono (Node)     |         43,706 |  1,116 |  1.432 |  2.823 |          32.8% |
| Express (Node)  |         28,115 |    588 |  2.245 |  2.938 |          21.1% |

**JSON** — `GET /json`

| Subject         | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| --------------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) |        122,988 |  3,537 |  0.493 |  1.004 |         100.0% |
| Elysia          |        122,133 |  6,948 |  0.484 |  0.993 |          99.3% |
| **@dunx/http**  |    **115,555** |  3,017 |  0.520 |  1.045 |      **94.0%** |
| Hono (Bun)      |         89,795 |  1,128 |  0.672 |  1.353 |          73.0% |
| node:http (raw) |         48,456 |  1,358 |  1.301 |  2.357 |          39.4% |
| Fastify (Node)  |         47,239 |  1,399 |  1.288 |  2.518 |          38.4% |
| Hono (Node)     |         36,856 |    465 |  1.695 |  3.345 |          30.0% |
| Express (Node)  |         26,127 |    443 |  2.427 |  3.308 |          21.2% |

**Path parameter** — `GET /params/42`

| Subject         | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| --------------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) |        126,458 |  1,335 |  0.469 |  0.970 |         100.0% |
| Elysia          |        120,728 | 12,241 |  0.484 |  1.010 |          95.5% |
| **@dunx/http**  |    **108,560** |  6,189 |  0.540 |  1.115 |      **85.8%** |
| Hono (Bun)      |         85,581 |  1,614 |  0.709 |  1.420 |          67.7% |
| node:http (raw) |         46,039 |    701 |  1.360 |  2.718 |          36.4% |
| Fastify (Node)  |         43,069 |  1,408 |  1.455 |  2.182 |          34.1% |
| Hono (Node)     |         36,271 |    544 |  1.721 |  3.224 |          28.7% |
| Express (Node)  |         25,350 |    296 |  2.531 |  3.187 |          20.0% |

**Body validation** — `POST /validate`

| Subject         | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |
| --------------- | -------------: | -----: | -----: | -----: | -------------: |
| Bun.serve (raw) |         83,160 |  3,413 |  0.711 |  1.492 |         100.0% |
| Elysia          |         66,597 |  4,363 |  0.882 |  1.778 |          80.1% |
| **@dunx/http**  |     **65,880** |  4,115 |  0.935 |  1.837 |      **79.2%** |
| Hono (Bun)      |         48,738 |  1,518 |  1.256 |  2.420 |          58.6% |
| node:http (raw) |         31,476 |    577 |  2.017 |  3.807 |          37.9% |
| Fastify (Node)  |         22,764 |    358 |  2.571 |  9.356 |          27.4% |
| Hono (Node)     |         21,204 |    339 |  2.962 |  5.514 |          25.5% |
| Express (Node)  |         18,378 |    449 |  3.363 |  6.547 |          22.1% |

**Startup** — cold process to first served request, 7 samples

| Subject         | median ms | min ms | max ms |
| --------------- | --------: | -----: | -----: |
| Bun.serve (raw) |      27.4 |   25.2 |   28.7 |
| Hono (Bun)      |      34.0 |   32.8 |   34.9 |
| **@dunx/http**  |  **53.5** |   50.7 |   54.8 |
| Elysia          |      61.9 |   59.3 |   68.0 |
| node:http (raw) |      74.5 |   71.1 |   76.2 |
| Hono (Node)     |      89.5 |   86.3 |   91.6 |
| Express (Node)  |     109.0 |  104.7 |  111.9 |
| Fastify (Node)  |     136.6 |  131.8 |  142.4 |

### What these say, including where dunx loses

**The dunx tax over raw `Bun.serve`** — the number this harness exists to produce:

| Scenario    | Bun.serve | @dunx/http | dunx costs |
| ----------- | --------: | ---------: | ---------: |
| `plaintext` |   133,382 |    123,493 |     −7.4%  |
| `json`      |   122,988 |    115,555 |     −6.0%  |
| `params`    |   126,458 |    108,560 |    −14.2%  |
| `validate`  |    83,160 |     65,880 |    −20.8%  |

Dispatch and serialisation cost 6–7%. A path parameter costs 14% — the framework
reads `req.params` and threads the value through the input reader, where the raw
subject reads it straight off the `BunRequest`. Validation costs 21%: that is a full
`req.json()`, a Standard Schema `validate` call and the error-mapping path, and it is
the largest single overhead dunx has.

**dunx loses to Elysia on all four scenarios.** 96.8% vs 92.6% on `plaintext`, 99.3%
vs 94.0% on `json`, 95.5% vs 85.8% on `params`; `validate` is 80.1% vs 79.2%, which
is inside the noise. The `params` gap is the real one and the most interesting
result here: Elysia compiles per-route handler code ahead of time, and dunx builds a
closure per route at boot but still runs a generic input reader per request.

**dunx loses on startup, roughly 2x.** 53.5 ms against raw `Bun.serve`'s 27.4 ms and
Hono's 34.0 ms. That is `@dunx/compiler`'s oxc parse of every loaded module plus the
container's eager DI resolution and route discovery — the deliberate trade recorded
in ARCHITECTURE.md, paid once at boot rather than per request. It is a real cost on a
short-lived process and does not matter at all on a long-lived one. dunx does beat
Elysia (61.9 ms) and every Node subject here.

**Validation plumbing, holding the validator constant.** The throughput drop from
`json` to `validate` is what each framework spends getting a body to zod and a result
back:

| Subject | Bun.serve | Express | node:http | Hono (Node) | **dunx** | Hono (Bun) | Elysia | Fastify |
| ------- | --------: | ------: | --------: | ----------: | -------: | ---------: | -----: | ------: |
| drop    |    −32.4% |  −29.7% |    −35.0% |      −42.5% | **−43.0%** |    −45.7% | −45.5% |  −51.8% |

dunx sits mid-pack and is meaningfully heavier than hand-wiring `safeParse` yourself.
Express and `node:http` look good here only because they were already slow enough
that zod is a smaller fraction of their per-request cost.

**Bun is worth about 2.3x on its own.** `hono-bun` at 101,667 against `hono-node` at
43,706 on `plaintext` is the same application code, so that ratio is the runtime and
nothing else. It is larger than any gap between frameworks on the same runtime, which
is the main thing to take away from the whole table.

**Fastify's `validate` p99 is 9.36 ms**, four times its p50 and far worse than anyone
else's ratio. That is zod being driven through `validatorCompiler`, which is not
Fastify's optimised path; with ajv it would not look like this.

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
