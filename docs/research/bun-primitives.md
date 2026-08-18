# Six Bun primitives, measured on Bun 1.3.14 (rev 0d9b296af)

Probes in `<SCRATCH>/probes/`, helper `probes/bench.ts`. Linux 6.6.87.2 WSL2 x64. Every figure is median and p99 over the stated iteration count, warmed up, timed with `Bun.nanoseconds()`. Nothing in `dunx` or `~/repos/arkv` was modified.

## A. Bun.inspect and the logger

**Verdict** - **reject** for `ConsoleLogger` and for `@dunx/infra/logger`:
`Bun.inspect(new Error('database connection refused'))` returns 333 bytes across
**7 lines** carrying a source excerpt of the throwing file, so a JSON-lines writer
using it emits one record per line and can print source that sat beside the throw.

**Evidence** - `probes/a-error-inspect.ts`, `a-inspect-behaviour.ts`,
`a-inspect-cost.ts` (run from `packages/infra`, `@arkv/logger` 0.10.0),
`a-cycle-cost.ts`, `a-fallback-cost.ts`. Behaviour table in the last section.
```
bun probes/a-error-inspect.ts
--- Bun.inspect(new Error(...)) : 333 bytes, 7 lines ---
1 | const SECRET_TOKEN = 'sk-live-do-not-log-me';
2 | const boom = (): Error => new Error('database connection refused');
3 | const err = boom();
                ^
error: database connection refused
      at .../probes/a-error-inspect.ts:3:13
--- contains the source line that declared SECRET_TOKEN: true

bun probes/a-inspect-cost.ts            (370-byte request-log entry)
realistic  JSON.stringify        20000     0.519us     4.076us
realistic  Bun.inspect           20000     6.538us    26.133us
realistic  sanitize+stringify    20000     4.810us    34.305us
pathological Bun.inspect / sanitize+stringify   18.562us / 16.435us  (n=2000)

bun probes/a-cycle-cost.ts
JSON.stringify(flat)             n=5000  median    0.104us
JSON.stringify(cyclic) caught    n= 500  median 1424.489us
Bun.inspect(cyclic)              n= 500  median    0.936us
```
**Where it applies** - `packages/core/src/logger/console.ts:144`
(`JSON.stringify(this.#entry(...))`) in its `catch` branch only.
`probes/a-fallback-cost.ts` puts that shape at 0.449 us on a clean entry against today's
0.662 us, and one line out on a cycle. The comment already at `console.ts:142-143` is
the right call and now has a number behind it: the sanitizer route costs 16.4 us on the
pathological entry against 1.42 ms for the `JSON.stringify` that fails, so 87x.
`packages/infra/src/logger/` needs nothing; upstream fixed all ten
`@arkv/logger@0.8.0` cases. Nothing goes upstream: `Bun.inspect` is a `Bun.*` API and
`@arkv` ships CJS for Node and the web.

**Cost** - 4 lines in one private method, no published API, no dependency. Risk: the fallback record must be fixed-shape with the inspected text as one string field and newlines stripped, or the JSON-lines contract breaks. Using `Bun.inspect` as the serializer is a breaking output-format change plus a source-disclosure defect.

## B. Bun.unsafe and bun:jsc

**Verdict** - **adopt narrowly**: `process.memoryUsage.rss()` at 4.224 us and
`jsc.heapSize()` at 2.155 us are cheap enough to read per dashboard poll, while
`jsc.heapStats()` at 2.209 ms and `Bun.generateHeapSnapshot()` at 11-15 ms must never
touch a request path, and `Bun.unsafe` holds exactly three functions of which none is
a memory metric.

**Evidence** - `probes/b-unsafe-jsc.ts`, `b-cost.ts`, `b-unsafe-calls.ts`. Per-call
cost table in the last section.
```
bun probes/b-unsafe-jsc.ts
Bun.unsafe.arrayBufferToString  ->  function(len=1)
Bun.unsafe.gcAggressionLevel    ->  function(len=1)
Bun.unsafe.mimallocDump         ->  function(len=1)
Object.keys (enumerable only): [ "gcAggressionLevel", "arrayBufferToString", "mimallocDump" ]
process.memoryUsage()  => {"rss":36536320,"heapTotal":676864,"heapUsed":175406,"external":11886,"arrayBuffers":0}
jsc.memoryUsage()      => {"current":36536320,"peak":36536320,"currentCommit":44630016,"peakCommit":44630016,"pageFaults":0}
jsc.heapSize() => 175406   Bun.gc(false) => 175406   jsc.heapStats() => 13,745 bytes
jsc.percentAvailableMemoryInUse() => null   process.resourceUsage().maxRSS => 35680 KiB
```
`Object.getOwnPropertyNames` finds nothing else on `Bun.unsafe`, so there are no
non-enumerable members. `bun:jsc` exports 37 names: `callerSourceOrigin codeCoverageForFile default describe describeArray deserialize drainMicrotasks edenGC estimateShallowMemoryUsageOf fullGC gcAndSweep generateHeapSnapshotForDebugging getProtectedObjects getRandomSeed heapSize heapStats isRope jscDescribe jscDescribeArray memoryUsage noFTL noInline noOSRExitFuzzing numberOfDFGCompiles optimizeNextInvocation percentAvailableMemoryInUse profile releaseWeakRefs reoptimizationRetryCount samplingProfilerStackTraces serialize setRandomSeed setTimeZone setTimezone startRemoteDebugger startSamplingProfiler totalCompileTime`.
Unsafe in production: `Bun.generateHeapSnapshot()` (11-15 ms stop-the-world),
`jsc.heapStats()` (2.209 ms), `Bun.gc(true)` / `gcAndSweep` / `fullGC` / `edenGC`
(1.9-2.6 ms synchronous), `gcAggressionLevel(n)` (process-global, no scoping),
`mimallocDump()` (unstructured stderr), `arrayBufferToString` (no validation), and the
JSC hooks `drainMicrotasks`, `noFTL`, `noInline`, `optimizeNextInvocation`,
`startSamplingProfiler`.

**Where it applies** - the `packages/dashboard/src/` runtime panel, with
`packages/dashboard/src/api/bounded.ts` as the existing pattern for a reading that
must not hang a page. Nowhere on a request path.

**Cost** - one reader class; published surface only if the dashboard payload type grows a field. Handoff: the metrics agent owns which of `rss`, `heapUsed`, `jsc.memoryUsage().peak` and `currentCommit` to expose and at what cadence, and the only constraint from here is that anything over ~5 us per read must be polled on a timer rather than sampled per request.

## C. process.on('beforeExit') and process.on('exit')

**Verdict** - **reject**: `beforeExit` fires only once the loop has drained, so the
`Bun.serve`-still-listening case never fired it and was `SIGKILL`ed at 9,007 ms,
which is exactly the bug class `ShutdownHooks` exists for.

**Evidence** - `probes/c-fixture.ts` and `c-driver.ts`, 16 spawned subprocesses;
`c-additive.ts`. Full path table in the last section.
```
bun probes/c-driver.ts
=== drain === exitCode=0 in 35ms
   out| beforeExit #1 code=0 / exit code=0 beforeExitFired=1
=== serve === exitCode=null signal=SIGKILL in 9007ms
   out| READY mode=serve / SERVING 34071            <- neither hook ran
=== sigterm-nohandler +SIGTERM === exitCode=null signal=SIGTERM in 254ms
   out| READY mode=sigterm-nohandler                <- neither hook ran
=== resurrect === beforeExit #1 / resurrected work ran / ... / beforeExitFired=3
=== async-exit === beforeExit #1 / exit  <- no MICROTASK/TIMER/queueMicrotask line
```
`c-additive.ts`: handlers are additive, `listenerCount exit = 2`, both ran in
registration order, `getMaxListeners()` is 10, and `process.exitCode` assigned inside
an `exit` handler takes effect, so a framework handler masks nothing.

**Where it applies** - `packages/core/src/logger/console.ts:74` already does the useful
half (`process.on('exit', flushPending)`), and the table shows its one gap: a default
SIGTERM with no handler runs neither hook, so a buffered `info` line is lost.
`packages/core/src/di/shutdown-hooks.ts:99` already covers the held-loop case with an
`unref()`d timer plus a named warning, and it fires in precisely the row where
`beforeExit` does not. Nowhere for `AppFactory` to subscribe.

**Cost** - zero, nothing to add. Adding `beforeExit` would be 3 lines of published behaviour that cannot observe the defect it was proposed for, plus a resurrection hazard on any handler that schedules work.

## D. Bun.main in the first application log line

**Verdict** - **adopt narrowly**: the six fields read in under 0.30 us total and
stringify in 0.191 us once per process, and dunx's one boot entry
(`Serving N route(s)`) carries no runtime identity today.

**Evidence** - `probes/d/entry.ts`, `d/preload.ts`, `d/main.test.ts`, `d/compiled.ts`,
`d-cost.ts`.
```
--- direct entry ---     Bun.main=/.../probes/d/entry.ts  (same from an imported module)
--- with --preload ---   Bun.main=/.../probes/d/entry.ts  <- set before the preload runs
--- bun test ---         Bun.main=/.../probes/d/main.test.ts  <- the TEST FILE, not the app
--- bun -e --- <cwd>/[eval]     --- stdin --- <cwd>/[stdin]
--- bun build --compile ---
compiled  Bun.main=/$bunfs/root/compiled-bin
compiled  execPath=/.../probes/d/compiled-bin
bun probes/d-cost.ts      (n=20000 each)
Bun.main 0.047us | Bun.version 0.028us | Bun.revision 0.040us | execPath 0.047us
Bun.env.NODE_ENV 0.046us | JSON.stringify(the 7 fields) 0.191us
```
Under `bun test` `Bun.main` is the current test file's path and changes per file, so it
is not the application entry there. Under `--compile` it is the virtual
`/$bunfs/root/<binary>` and needs `process.execPath` beside it to name a real file.

**Where it applies** - `packages/http/src/server/application.ts:369-387`
(`#logServed`), the one boot entry dunx emits;
`packages/infra/src/queue/worker.ts:149` is the consuming side's equivalent.
`ConsoleLogger` already stamps `pid` and `timestamp` on every entry
(`packages/core/src/logger/console.ts:174-175`), so neither is a field to add.
Proposed, message unchanged and six fields added:
```
Serving 12 route(s) and 1 gateway(s)
  runtime "bun 1.3.14" (Bun.version) | revision "0d9b296af" (Bun.revision.slice(0, 9))
  main "/app/src/main.ts" (Bun.main) | execPath "/app/api" (differs under --compile)
  env "production" (Bun.env.NODE_ENV) | version "2.0.1" (the app's, if it passes one)
```
**Cost** - about 8 lines inside `#logServed`, plus the app's own version as an optional `HttpApplicationOptions` field if it is wanted; that field is published API and the rest is not. `bootLogging: false` already silences it.

## E. Bun.sleep and Bun.sleepSync

**Verdict** - **already adopted, one gap**: `Bun.sleep` is the repo's sleep primitive
at 90-plus sites with no `Atomics.wait` and no `Bun.sleepSync` anywhere, so the only
change available is one promisified sleep at `internal/docs/src/charts.test.tsx:124`;
at 1 ms and above all four primitives are within 0.03 ms of each other.

**Evidence** - `probes/e-sleep.ts`, `e-order.ts`, `e-flush.ts`. Overshoot table in the
last section. The one real difference is at 0 ms, and it is semantic:
```
bun probes/e-order.ts
ordering: queueMicrotask -> Promise.resolve -> setImmediate -> Bun.sleep(0) resolved -> setTimeout(0) callback
after Bun.sleep(0), a setTimeout(0) queued before it had run: false
after setTimeout-promise(0), same: true
after Bun.sleep(1), same: true
bun probes/e-flush.ts  (ConsoleLogger's own setTimeout(flush, 0).unref() shape)
ConsoleLogger batch after await Bun.sleep(0): 0 line(s) written
ConsoleLogger batch after await Bun.sleep(1): 1 line(s) written
bun probes/e-sleep.ts  median [overshoot]
0ms: Bun.sleep 0.0011ms | setTimeout promise 1.2340ms | sleepSync 0.0790ms | Atomics.wait 0.0002ms
5ms: Bun.sleep 5.5411ms | setTimeout promise 5.5179ms | sleepSync 5.4863ms | Atomics.wait 5.4905ms
sleepSync(-1) threw: argument to sleepSync must not be negative, got -1; sleep(-1) accepted
```
**Where it applies** - one candidate: `internal/docs/src/charts.test.tsx:124-125`,
`new Promise((resolve) => setTimeout(resolve, 20))`, which is `await Bun.sleep(20)`.
Everything else shaped like a sleep is a timeout guard or a race and must stay a
`setTimeout` it can `clearTimeout`: `infra/src/queue/dispatcher.ts:66`,
`dashboard/src/api/bounded.ts:24`, `http/src/ws/pubsub.ts:125`,
`core/src/di/shutdown-hooks.ts:99`, `core/src/logger/console.ts:71`,
`internal/dashboard-ui/src/poll.ts:63` (all under `packages/` unless noted).
`packages/http/src/client/retry.ts:160` is already `await Bun.sleep(delayMs)`, the only
`Bun.sleep` in shipped non-test code. Two tests use `await Bun.sleep(0)` where the
intent reads as "yield a turn", `packages/testing/src/app.test.ts:116` and
`packages/auth/src/guard.test.ts:181`; both pass today, and the ordering result says
`Bun.sleep(1)` is what lets a queued timer run. `sleepSync` is recommended **nowhere**:
it blocks the loop and costs 0.079 ms even at an argument of 0.

**Cost** - 1 line in one internal test file. No published API. Risk zero.

## F. Bun.peek and the middleware chain

**Verdict** - **reject**: the fast path cannot fire, because `Bun.peek.status` on the
result of any middleware that `await`s or `.then()`s its `next()` reads `pending`
(measured `fired=0` for both), and where it can fire the whole 5-layer saving is
0.021 us against a 0.207 us chain.

**Evidence** - `probes/f-peek-semantics.ts`, `f-reject-fixture.ts`, `f-await-cost.ts`,
`f-directOr.ts`, `f-e2e.ts`. Semantics table in the last section.

`compose` at `packages/http/src/server/middleware.ts:25-32` folds right at boot into one
closure per route, `(next, current) => (req) => current.handle(req, ctx, () => next(req))`.
Callers: `routes.ts:311` for the route table, `routes.ts:184` for the 404 fallback. The
chain is never empty by default, since `RequestLoggingMiddleware` is installed
outermost, and `routes.ts:317` gates the `directOr` fast path on `chain.length === 0`.
In `packages/*/src` there is **no `await next()` at all**: `request-logging.ts:293`,
`:302` and `:320` use `.then()`, and `static/files.ts:90-101`, `auth/src/guard.ts:66`
and `dashboard/src/middleware.ts:69` `return next()`. The two `await next()` sites are
sample code, `examples/full/src/http/request-log.ts:29` and
`tools/create-app/templates/features/http/request-log.ts:29`.
```
bun probes/f-peek-semantics.ts
Bun.peek own props: [ "length", "name", "status" ]   typeof Bun.peek.status: function
new Promise(never)                   peek={}          status=pending    sameObject=true
non-promise thenable                 peek={}          status=fulfilled  sameObject=true
async fn: no await, returns value    peek=42          status=fulfilled
async fn: awaits resolved promise    peek={}          status=pending
settled.then(identity)               peek={}          status=pending
Promise.reject(Error)                peek=Error: nope status=rejected
bun probes/f-reject-fixture.ts peek
status = rejected / peek = Error: the-rejection / unhandledRejection: the-rejection
bun probes/f-await-cost.ts
peek over ONE async+await layer:               fired=0 missed=1
peek over ONE pass-through layer:              fired=1 missed=0
peek over an async layer awaiting the bottom:  fired=0 missed=1
peek over a .then() layer:                     fired=0 missed=1
peek over an async layer with NO await:        fired=1 missed=0
await settled  (same promise)     50000  0.209us  2.913us
Bun.peek.status(settled) only     50000  0.062us  0.237us
chain x5  async+await next()      50000  0.724us  2.565us
chain x5  pass-through            50000  0.207us  0.592us
chain x5  peek fast path          50000  0.186us  1.703us
```
Three traps, spelled out in the last section: a pending promise is returned as itself,
a non-promise thenable reports `fulfilled`, and peeking a rejection does not mark it
handled.

The premise in the brief is half wrong, and the correct half is narrower. An `async`
function that reaches `return` without executing an `await` **does** settle
synchronously. What kills the idea is that every way a middleware can look at the
response yields a pending promise, so for the fast path to fire a `handle` would have
to be non-`async`, return `next()` verbatim, and never read the response: a middleware
that does nothing. The 5-layer `async`-plus-`await` shape costs 0.517 us more than the
pass-through shape, 0.10 us per layer, and `Bun.peek` removes none of it. JSC's
`await` on a settled native promise is 0.209 us, so the microtask the idea targets is
3.4x a `Bun.peek.status` call, not 100x it.

One adjacent shape survives. `directOr` at `packages/http/src/server/routes.ts:239-253`
already branches on `value instanceof Promise`; adding `Bun.peek.status` covers a
handler declared `async` that executes no `await`.
```
bun probes/f-directOr.ts                                       (n=30000 each)
async no-await   today 1.190us / peek 0.908us   sync handler today 1.032us / peek 1.004us
async with await today 1.214us / peek 1.395us
bun probes/f-e2e.ts  (internal/bench fetch-worker shape, in process, 32 conns, 2s x5)
today (.then)   43711 47447 45401 44142 15570   median 44142 req/s
peek fast path  42756 46106 50456 20803 17782   median 42756 req/s
delta -3.14%  |  round-to-round spread: today 72.22%, peek 76.42%
```
0.282 us on the `async no-await` shape, 0.181 us **worse** on the `async with await`
shape, which is the commoner one. End to end that is not resolvable here: `oha` is
absent and `bun run setup` would modify the repo, and a 72% round-to-round spread
cannot resolve a claimed 3%. `internal/bench/README.md` already puts the fetch
driver's ceiling at ~80k req/s against oha's ~503k.

**Where it applies** - **nowhere** for the middleware chain.
`packages/http/src/server/middleware.ts:31` stays as it is, and
`packages/http/src/server/request-logging.ts` is already written in the shape that
avoids the cost. `routes.ts:239-253` is the only candidate and needs an oha number
before it earns 6 lines.

**Cost** - if `directOr` were changed: about 6 lines plus a `void value.catch()` on the rejected branch to stop the `unhandledRejection` the probe reproduced, and a `typeof p.then === 'function'` guard is not sufficient because a thenable reports `fulfilled`. No published API. Risk: returning a plain `Response` synchronously changes the type Bun sees for that route, which `middleware.ts:22` already allows.

## Ranked

1. **D. Bun.main in the boot line** - 8 lines, 0.191 us once per process, and it names
   the build, the entry and the runtime in logs that name none of them today.
2. **E. Bun.sleep** - already adopted; the deliverable is the `Bun.sleep(0)` ordering
   fact, one doc line and one test-file line.
3. **B. bun:jsc memory reads** - 4.224 us `rss()` and 2.155 us `heapSize()` are usable,
   and the enumeration rules out `Bun.unsafe` as a metrics source.
4. **A. Bun.inspect** - 4 lines in `console.ts:144`'s `catch` at best, and
   `@dunx/infra/logger` already solves it 87x cheaper on the pathological entry.
5. **C. beforeExit** - zero lines: the row where it would have helped is the one row in
   the table where it does not fire.
6. **F. Bun.peek in the chain** - zero lines, and the measurement saying so is the
   most useful thing in this file.

## For docs/bun-apis.md

### `Bun.inspect` is not a serializer, and on an `Error` it prints source

- Output is **multi-line for every object**, so a JSON-lines writer using it emits one record per line. `compact`, `breakLength`, `sorted`, `showHidden` and `numericSeparator` are accepted and **ignored**: output is byte-identical with and without them. Only `depth` and `colors` change anything.
- `Bun.inspect(new Error('...'))` returns the **source excerpt around the throw
  site**: 7 lines and 333 bytes for a 3-line file, including the lines above it. A
  secret declared on the line before the throw appeared in the output. Also true under
  `NO_COLOR=1` with stdout piped.
- Getters print `[Getter]` and are never evaluated, so a working accessor loses its
  value, and `toJSON()` is ignored.
- It handles what `JSON.stringify` refuses: a cycle becomes `[Circular]`, a
  self-referencing array `[ 1, [Circular] ]`, `BigInt` `10n`, a revoked `Proxy`
  `<Revoked Proxy>`; a `Map`/`Set` prints its contents where `JSON.stringify` gives
  `{}`; a 1 MiB `Uint8Array` prints 2,104 bytes against 12,520,387. A shared
  non-cyclic reference is printed twice rather than misreported as circular.
- Cost on a 370-byte structured log entry: 6.538 us against `JSON.stringify`'s
  0.519 us, so 12.6x. `Bun.inspect.custom === Symbol.for('nodejs.util.inspect.custom')`
  and is honoured; `Bun.inspect.table(rows)` returns a box-drawing string.

### `JSON.stringify` on a cyclic object costs milliseconds to fail

A two-key object holding one back-reference: **1424.489 us median** over 500 iterations, against 0.104 us for the same object without the cycle. It is not the throw (constructing and catching an `Error` is 0.202 us) and not the depth (a 50-level cycle is 688.922 us, less). `Bun.inspect` on the same value is 0.936 us. A logger that hands user objects to `JSON.stringify` without a `WeakSet` walk first pays this per cycle.

### `Bun.unsafe` holds three functions, none of them a memory metric

`gcAggressionLevel`, `arrayBufferToString`, `mimallocDump`, all enumerable;
`Object.getOwnPropertyNames` finds nothing else.

- `arrayBufferToString` reinterprets bytes as UTF-16 with no validation:
  `Uint16Array([104, 105])` becomes `"hi"`. 0.072 us against `TextDecoder`'s 0.104 us.
- `gcAggressionLevel(n)` mutates process-global GC behaviour with no scoping; the read
  is 0.046 us and returns 0 by default.
- `mimallocDump()` writes ~40 unstructured lines to stderr and takes 15.810 us.

Memory readings and what each costs:

| call                                  | median   | shape                                              |
| ------------------------------------- | -------- | -------------------------------------------------- |
| `jsc.percentAvailableMemoryInUse()`   | 0.035 us | **returns `null`** on Linux                        |
| `jsc.estimateShallowMemoryUsageOf(v)` | 0.043 us | bytes for one object                               |
| `process.resourceUsage()`             | 0.456 us | `.maxRSS` in KiB                                   |
| `jsc.heapSize()`                      | 2.155 us | JS heap bytes, same number as `Bun.gc(false)`       |
| `Bun.gc(false)`                       | 3.412 us | does not collect, returns the heap size             |
| `process.memoryUsage.rss()`           | 4.224 us | one number                                         |
| `process.memoryUsage()`               | 4.315 us | `rss heapTotal heapUsed external arrayBuffers`      |
| `jsc.memoryUsage()`                   | 5.114 us | `current peak currentCommit peakCommit pageFaults`  |
| `jsc.edenGC()`                        | 1898 us  | synchronous                                        |
| `jsc.heapStats()`                     | 2209 us  | 13,745 bytes of object type counts                  |
| `Bun.gc(true)`                        | 2365 us  | synchronous full GC                                |
| `jsc.gcAndSweep()`                    | 2600 us  | synchronous                                        |
| `Bun.generateHeapSnapshot()`          | 11-15 ms | 0.15-0.17 MiB of JSON; `'v8'` returns a string      |

`bun:jsc` exports 37 names on 1.3.14, including the JSC test hooks `noFTL`, `noInline`,
`optimizeNextInvocation`, `drainMicrotasks` and `startSamplingProfiler`, which change
codegen or the microtask queue and are not diagnostics.

### `beforeExit` does not fire when the loop is held open

Measured with 16 spawned subprocesses.

| exit path                        | `beforeExit` | `exit` | status         |
| -------------------------------- | ------------ | ------ | -------------- |
| natural drain                    | yes          | yes    | 0              |
| `process.exit(n)`                | no           | yes    | n              |
| throw from a timer callback      | yes, code 1  | yes    | 1              |
| throw at top level               | no           | yes    | 1              |
| unhandled rejection              | yes, code 0  | yes    | **1**          |
| `Bun.serve` still listening      | **no**       | **no** | SIGKILL at 9 s |
| `Bun.serve` after `await stop()` | yes          | yes    | 0              |
| SIGINT or SIGTERM with a handler | no           | yes    | handler's code |
| **SIGTERM with no handler**      | **no**       | **no** | signal SIGTERM |
| SIGKILL                          | no           | no     | signal SIGKILL |

So `beforeExit` cannot observe a handle keeping the process alive, and neither hook runs
on a default SIGTERM. Async work scheduled from an `exit` handler never runs (a
microtask, a `queueMicrotask` and a `setTimeout(0)` all produced no output); scheduling
work from `beforeExit` **resurrects** the process, and it fired three times before the
loop drained; handlers are additive, so a framework's does not mask a consumer's,
`getMaxListeners()` is 10, and `process.exitCode` set inside `exit` takes effect.

### `Bun.main`

The absolute path of the entry script, read in 0.047 us, identical inside an imported
module and inside a `--preload` file (it is set before the preload runs). Three
contexts where it is not the application entry:

| context               | `Bun.main`                                                     |
| --------------------- | -------------------------------------------------------------- |
| `bun test`            | the **current test file**'s path, so it changes per file        |
| `bun build --compile` | `/$bunfs/root/<binary>`, virtual; `process.execPath` is the real one |
| `bun -e` / stdin      | `<cwd>/[eval]` / `<cwd>/[stdin]`                               |

`Bun.version` is 0.028 us, `Bun.revision` 0.040 us and 40 hex characters,
`process.execPath` 0.047 us, `Bun.env.NODE_ENV` 0.046 us; six stringify in 0.191 us.

### `Bun.sleep(0)` resolves ahead of an already-queued `setTimeout(0)`

```
queueMicrotask -> Promise.resolve -> setImmediate -> Bun.sleep(0) -> setTimeout(0) callback
```

`await Bun.sleep(0)` does not flush the timer queue: a `setTimeout(cb, 0)` registered
before it has still not run afterwards, where `await Bun.sleep(1)` and
`await new Promise((r) => setTimeout(r, 0))` both let it run. Reproduced against
`ConsoleLogger`'s coalescing window, a `setTimeout(flush, 0).unref()`: 0 lines written
after `Bun.sleep(0)`, 1 line after `Bun.sleep(1)`.

At 1 ms and above `Bun.sleep`, a promisified `setTimeout`, `Bun.sleepSync` and
`Atomics.wait` are equivalent, with median overshoot 0.19-0.21 ms at 1 ms,
0.49-0.54 ms at 5 ms and 0.51-1.86 ms at 50 ms; none has finer resolution than
another. `Bun.sleep(0)` settles in 0.0011 ms against the promisified `setTimeout(0)`'s
1.2340 ms, `Bun.sleepSync(0)` costs 0.0790 ms and `Atomics.wait(arr, 0, 0, 0)`
0.0002 ms. `Bun.sleepSync(-1)` throws `argument to sleepSync must not be negative`;
`Bun.sleep(-1)` is accepted.

### `Bun.peek` semantics, and why it does not shorten an `await` chain

`Bun.peek.status(p)` exists and returns `'pending' | 'fulfilled' | 'rejected'`. A
**pending** promise is returned as itself, so `Bun.peek(p) !== p` is not a usable
settled test; a **non-promise thenable** reports `fulfilled` and peeks to itself; a
**rejected** promise peeks to the rejection reason, and peeking does **not** mark it
handled, so `unhandledRejection` still fires.
`Bun.peek(Promise.resolve(response)) === response`, identity preserved.

What is settled at the moment of the call:

| expression                               | status      |
| ---------------------------------------- | ----------- |
| `(async () => 42)()`                     | fulfilled   |
| `(() => Promise.resolve(42))()`          | fulfilled   |
| `(async () => Promise.resolve(42))()`    | **pending** |
| `(async () => { await x; return 42 })()` | **pending** |
| `settled.then((v) => v)`                 | **pending** |
| `Promise.all([Promise.resolve(1)])`      | **pending** |

An `async` function that reaches `return` without executing an `await` settles
synchronously; no other shape does, which includes every way a middleware can read the
value it passes on. Costs: `await` on an already-settled native promise 0.209 us,
`Bun.peek.status` 0.062 us, `Bun.peek` 0.072 us. A 5-layer chain of `async` layers each
doing `await next()` is 0.724 us, the same 5 as non-`async` pass-throughs 0.207 us, and
a `Bun.peek` fast path over that chain 0.186 us: the 0.517 us the chain shape costs is
async frames, and `Bun.peek` removes 0.021 us of it.
