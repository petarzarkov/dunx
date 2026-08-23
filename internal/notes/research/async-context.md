# Explicit async context

## Verdict

No. An explicit context does not recover the 0.91 microseconds the roadmap
attributes to `AsyncLocalStorage`, because `AsyncLocalStorage` is not what costs
that: `storage.run(scope, fn)` measures **17.7 ns** on Bun 1.3.14, while the
object copying `AsyncRequestContext` wraps around it measures **148.6 ns** in the
same loop, and on an authenticated request nesting `AuthContext`'s second store
inside `RequestContext`'s takes the pair to **363.7 ns**. Threading the scope as
a parameter through the whole chain lands at **8.6 ns**; two changes that keep
`AsyncLocalStorage` and touch nothing public land at **47.2 ns** unauthenticated
and **26.0 ns** authenticated. So the explicit design buys **21 to 39 ns per
request** over a fix inside `AsyncRequestContext.runWithContext`, against
widening `Middleware.handle` and `Next` for every consumer, losing the store in
every place a parameter cannot reach (17 measured, listed below), and giving up
correlation in `@arkv/logger`, which reads its own ambient store internally. Take
the two internal fixes; keep the binding.

## What Bun gives us

Every number below is from one machine: 12th Gen Intel Core i7-12700H, 20 logical
cores, 16 GB, Linux 6.6.87.2 under WSL2, Bun 1.3.14 (`0d9b296af`), idle. Probes are
in `<SCRATCH>/probes/`. Medians and p99 are over 51 batches, each preceded by
200,000 warmup iterations for the synchronous harness and 50,000 for the
asynchronous one, timed with `Bun.nanoseconds()`.

### 1. Baseline cost of the primitive

`bun p1b-baseline.ts` (`<SCRATCH>/probes/p1b-baseline.ts`, full output in
`p1b-baseline.out`). Synchronous cases run in a synchronous loop so the harness
contributes no `await`; 200,000 calls per batch.

```
bun 1.3.14 (0d9b296af)
SYNC CASES (synchronous loop, no await in the harness)
| case                                         | median ns |    p99 ns |    min ns |
| -------------------------------------------- | --------- | --------- | --------- |
| plain sync function call                     |       0.5 |       3.5 |       0.5 |
| module-level variable read                   |       1.3 |       5.1 |       0.2 |
| als.getStore(), no store active              |       3.3 |       7.5 |       0.4 |
| als.run(store, syncFn)                       |      16.2 |      42.2 |      12.9 |
| als.run(store, () => als.getStore())         |      22.2 |      41.5 |      16.5 |
| als.run x8 distinct instances                |     146.2 |     339.2 |     116.1 |
| 8 nested als.run + innermost getStore()      |    1075.1 |    1464.1 |     896.6 |
| als.getStore() with 8 stores nested          |    1293.3 |    1677.3 |    1119.6 |
```

Depth costs nothing measurable. The same probe wraps an async chain of 1, 5 and 20
awaits in `als.run` and compares it against the identical chain unwrapped, batch by
batch interleaved so drift cancels. Paired deltas, wrapped minus unwrapped:

```
1 await:   median  26.5 ns   p99  169.4 ns
5 awaits:  median   2.9 ns   p99  645.5 ns
20 awaits: median -166.5 ns  p99 3929.7 ns
```

The delta does not grow with depth and changes sign at 20 awaits, so propagation
across an await is below the noise floor of this setup. The cost is at entry.

### 2. `enterWith()` against `run()`

`bun p2a-enterwith-noawait.ts` through `p2e-run-settimeout.ts`. The segfault in
`docs/bun-apis.md` reproduces, and the `setTimeout` case is new: the store survives
a macrotask, so the crash is specific to the promise path.

```
----- p2b-enterwith-await -----
before await, getStore(): 1
panic(main thread): Segmentation fault at address 0x10
exit=132
----- p2c-enterwith-settimeout -----
inside setTimeout, getStore(): 7
exit=0
run() async callback, 300000 iterations, correct store seen: 300000
exit=0
run() + setTimeout, getStore(): 42
```

`enterWith` cannot be timed against `run`: a process that calls it and then awaits
does not survive to print a number.

### 3. What the machinery costs when no store is active

This was the measurement expected to change the design, and it does not. One
subprocess per condition, interleaved across 7 repetitions so no process
contaminates another, with a `syncCall` row as the control that cannot be affected
by anything in the list. `bun p3-run2.ts 7`
(`<SCRATCH>/probes/p3-run2.ts`, workload in `p3-workload.ts`, drivers in
`p3-drv-none.ts` and `p3-drv-als.ts`; `p3-drv-none.ts` never imports
`node:async_hooks`).

```
bun 1.3.14 (0d9b296af)  reps=7, interleaved, one subprocess per (condition, rep)

### asyncChain5 (per-op ns, median over 7 subprocesses)
| none (async_hooks never imported)     |    437.00 |    961.07 |    0.0% |
| import-only (imported, nothing built) |    408.91 |    907.34 |   -6.4% |
| constructed (new ALS, never run)      |    419.92 |   1020.59 |   -3.9% |
| ran-once (one als.run, then exited)   |    400.78 |    800.43 |   -8.3% |
| ran-1000 (1000 als.run, then exited)  |    523.31 |   1042.71 |   19.7% |
| inside-store (workload inside als.run) |    432.49 |    908.20 |   -1.0% |
| createHook({...}).enable()            |    425.91 |    872.63 |   -2.5% |
```

Columns are median ns, p99 ns, and percent against `none`. The `syncCall` control
in the same run, which nothing in the list can affect, swings from -10.2% to
+5.4%, which sets the noise band for this setup at about plus or minus 11%. Only
`ran-1000` reads outside it, so it was
re-run on its own at 15 interleaved repetitions with the per-subprocess range
printed (`bun p3-focus.ts`):

```
bun 1.3.14  REPS=15 interleaved
| workload    | condition    | median ns | across-subprocess range |
| ----------- | ------------ | --------- | ----------------------- |
| asyncChain5 | none         |    390.73 |            319.7..529.3 |
| asyncChain5 | ran-1000     |    408.02 |            341.1..542.0 |
| asyncChain5 | inside-store |    424.15 |            381.0..583.8 |
| syncCall    | none         |      4.18 |                3.5..7.1 |
| syncCall    | ran-1000     |      4.11 |                3.4..7.7 |
| syncCall    | inside-store |      4.62 |                3.8..6.8 |
```

The ranges overlap on every row. **Importing `node:async_hooks`, constructing an
`AsyncLocalStorage`, and running 1000 stores all leave async function performance
where it was**, and a live store does not move it either. There is no Node-style
`enableAsyncHooks` cliff to trip, because there is no Node-style `async_hooks` in
Bun to enable: `bun p4b-createhook.ts` shows `createHook` is a stub.

```
createHook init callbacks fired: 0  before: 0
executionAsyncId(): 0 triggerAsyncId(): 0
AsyncLocalStorage.snapshot() outside restores store: 5
AsyncLocalStorage.bind() outside restores store: 9
```

### 4. What else Bun and JSC expose

`bun enumerate.ts` (full output in `enumerate.out`). Nothing in `bun:jsc` is an
async context primitive: the 36 exports are GC, heap, sampling profiler, JIT
controls (`noInline`, `optimizeNextInvocation`, `numberOfDFGCompiles`),
`serialize`/`deserialize` and `setTimeZone`. `Bun.unsafe` is three functions,
`arrayBufferToString`, `gcAggressionLevel`, `mimallocDump`. `globalThis.AsyncContext`
is `undefined`, so the TC39 proposal is not reachable. `node:async_hooks` exports
eight names, and only three carry behaviour:

| Name                                           | What it actually is on Bun 1.3.14                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `AsyncLocalStorage`                            | Working. Prototype: `run`, `getStore`, `enterWith`, `exit`, `disable`, plus internal `_enable`, `_propagate` |
| `AsyncLocalStorage.snapshot()`                 | Working. Returns a function that replays the captured store outside its scope                                |
| `AsyncLocalStorage.bind(fn)`                   | Working. Same capture, wrapped around one function                                                           |
| `AsyncResource`                                | Constructs, `runInAsyncScope` runs the callback, `asyncId()` returns `0`                                     |
| `createHook`                                   | Stub. `enable()` and `disable()` exist; no callback ever fires                                               |
| `executionAsyncId`, `triggerAsyncId`           | Always `0`                                                                                                   |
| `executionAsyncResource`, `asyncWrapProviders` | An empty-shaped object, and 58 constant names                                                                |

The shortlist for an alternative mechanism is `AsyncLocalStorage`, its
`snapshot`/`bind` statics, or a parameter. There is no third primitive.

### 5. The 5-middleware chain, in process and over a socket

`bun p5b-inprocess.ts` builds a 5-middleware chain folded at boot the way
`@dunx/http`'s `compose` does, in nine strategies, every one minting a request id
with `crypto.randomUUID()` and returning identical response bytes
(`<SCRATCH>/probes/p5-chain2.ts`). The floor passes the id through a module-level
slot, which no concurrent server may do and which prices propagation at zero.

```
bun 1.3.14 (0d9b296af)  5 middlewares + handler, in process, 51 batches x 20000 calls, interleaved
| strategy               | median ns |  p99 ns |  min ns | vs floor |
| ---------------------- | --------- | ------- | ------- | -------- |
| module-var (floor)     |    1174.8 |  2204.2 |   967.1 |     +0.0 |
| als-bare               |    1255.4 |  1908.2 |   986.0 |    +80.7 |
| als (dunx shape)       |    1460.5 |  2067.6 |  1170.1 |   +285.7 |
| explicit object        |    1353.8 |  2250.2 |  1151.3 |   +179.0 |
| hybrid                 |    1382.7 |  2956.5 |  1115.0 |   +207.9 |
| hybrid-lazy            |    1380.3 |  2115.8 |  1087.9 |   +205.5 |
| als + 3-hop read       |    1484.2 |  2394.2 |  1127.9 |   +309.4 |
| explicit + 3-hop read  |    1354.8 |  2135.4 |  1106.1 |   +180.1 |
```

`als (dunx shape)` minus `explicit object` is 107 ns here and 195 ns on a second
run; the 3-hop pair gives 129 ns and 159 ns. Response and JSON allocation dominate
the row, so this harness resolves the delta to about plus or minus 90 ns.

Over a socket the median does not resolve it at all. `bun p10-drive.ts` times the
chain inside the server so the JavaScript driver is outside the measurement, at
concurrency 4, 30,000 measured requests, 5 interleaved runs per strategy:

```
| strategy               | p50 ns | p90 ns | p99 ns | min ns | vs floor p50 |
| ---------------------- | ------ | ------ | ------ | ------ | ------------ |
| module-var (floor)     |   3144 |  13479 |  43155 |    987 |           +0 |
| als-bare               |   4860 |  17724 |  53593 |   1090 |        +1716 |
| als (dunx shape)       |   4196 |  16911 |  48710 |   1202 |        +1052 |
| explicit object        |   2676 |  13091 |  37384 |   1088 |         -468 |
| hybrid                 |   7861 |  26723 |  92075 |   1520 |        +4717 |
| als + 3-hop read       |   3394 |  14836 |  44175 |   1233 |         +250 |
| explicit + 3-hop read  |   2345 |   8893 |  22491 |   1046 |         -799 |
```

`als-bare` above `als (dunx shape)`, and `hybrid` above both, are impossible
orderings, so the p50 column is noise at this scale. The `min` column keeps the
ordering and the magnitude: `als` 1202 against `explicit object` 1088 is +114 ns,
and the 3-hop pair is +187 ns, both consistent with the in-process numbers. A
`Bun.serve` request costs 7 to 15 microseconds end to end here, so a 100 to 300 ns
term sits under the 3% the repo's harness calls noise. **The in-process
decomposition is the arbiter here, not a throughput run.**

### 6. Where the 0.91 microseconds actually is

`bun p6-decompose.ts` and `bun p6b-confirm.ts` split
`AsyncRequestContext` into the primitive and the copying around it.

```
| case                                         | median ns |    p99 ns |    min ns |
| -------------------------------------------- | --------- | --------- | --------- |
| crypto.randomUUID()                          |      86.9 |     170.8 |      66.3 |
| storage.run(scope, fn)  [bare ALS]           |      17.7 |      34.8 |      13.7 |
| storage.run({...getStore(),...scope}, fn)    |     126.1 |     201.5 |      92.5 |
|   ^ the merge alone, no run                  |     108.0 |     173.6 |      89.3 |
| getStore() inside a scope                    |      27.8 |      54.1 |      17.3 |
| {...getStore()} inside a scope  [getContext] |      46.8 |     101.0 |      30.9 |
| full dunx shape: runWithContext + 1 getContext |     162.7 |     233.4 |     136.6 |
| full dunx shape + 2 getContext (2 log lines) |     217.0 |     294.7 |     188.4 |
| explicit equivalent: pass scope, 2 spreads   |      53.8 |      84.3 |      42.4 |
| nested: RequestContext.run + AuthContext.run |     378.4 |     699.5 |     286.0 |
```

Two causes, both confirmed in isolation by `p6b-confirm.ts`:

```
A. object spread cost, by number of sources
| {...scope}                (1 source)         |      21.9 |      72.9 |      17.1 |
| {...undefined, ...scope}  (2 sources)        |     112.9 |     203.9 |      90.9 |
| {...other, ...scope}      (2 sources)        |     131.7 |     214.2 |     106.0 |
| Object.assign({}, other, scope)              |     111.7 |     166.0 |      81.1 |
| explicit 5-key literal                       |      16.6 |      34.9 |      13.2 |

B. nested run: same instance vs a second instance
| a.run(scope, fn)                       depth 1 |      18.8 |      32.3 |      16.0 |
| a.run(scope, () => a.run(scope, fn))   same inst |     102.1 |     214.7 |      86.5 |
| a.run(scope, () => b.run(scope, fn))   2nd inst |     200.6 |     301.5 |     153.1 |
```

A two-source object spread costs 5 to 6 times a one-source spread on this JSC, and
entering a **second** `AsyncLocalStorage` instance while one is live costs 10 times
the first entry. The nesting curve in `p6-decompose.out` separates the two shapes:
16 distinct instances nested reach 3516.9 ns (219.8 ns per level, rising), while
one instance re-entered 16 times reaches 890.1 ns (55.6 ns per level, flat).

So the per-request context cost, reproduced across four runs of `p6b-confirm.ts`,
is 157 to 193 ns unauthenticated and 367 to 424 ns authenticated, against 32 to 36 ns
for a parameter. The `run` call is 18 ns of that.

### 7. The hybrid, and two fixes that keep the store

`bun p8-cheapfix.ts`, three runs, all agreeing within 15 ns:

```
runWithContext, outermost (no enclosing store)
| shipped: {...getStore(), ...ctx}             |     148.6 |     212.3 |     122.7 |
| fix1: skip merge when no enclosing store     |      47.2 |     106.8 |      31.7 |
| fix3: Object.create(cur) prototype           |      47.8 |     112.5 |      34.5 |
| explicit: pass ctx, read a field             |       8.6 |      12.3 |       6.9 |

nested case (an enclosing store IS present)
| shipped, nested                              |     228.0 |     322.3 |     192.8 |
| fix1, nested                                 |     215.9 |     336.6 |     180.8 |

authenticated path: can AuthContext share the one store?
| shipped: 2 instances (RequestContext + AuthContext) |     363.7 |     511.6 |     315.5 |
| fix1 + one store, principal set after entry  |      26.0 |      59.9 |      16.9 |
```

The hybrid keeps almost nothing. `hybrid` in table 5 sits 29 ns above `explicit
object` on one run and 31 ns on another, because the `storage.run` it retains is
the 18 ns half. `hybrid-lazy`, which opens the scope only when a fallback reader
registered at boot, lands within 27 to 68 ns of `explicit object`, inside the
harness noise, so its saving is the saving `fix1` gets with no API change.

### 8. Where an ambient store reaches, and where a parameter would have to

`bun p11-semantics.ts`: one scope, read from 17 places.

```
| where the store is read                                     | store   |
| ----------------------------------------------------------- | ------- |
| sync, same frame                                            | R1      |
| after one await                                             | R1      |
| after Bun.sleep(1)                                          | R1      |
| after a setTimeout promise                                  | R1      |
| after queueMicrotask                                        | R1      |
| EventEmitter listener registered outside, emitted inside    | R1      |
| field initializer of a class constructed inside the scope   | R1      |
| method on a singleton constructed at boot                   | R1      |
| ReadableStream pull() on a stream made inside               | R1      |
| inside a Promise.all branch                                 | R1      |
| setInterval callback                                        | R1      |
| third-party callback, called on a later turn                | R1      |
| singleton field initializer at boot, no request active      | LOST    |
| callback stored inside, invoked outside the scope           | LOST    |
| queued inside, drained on a later turn outside              | LOST    |
| AsyncLocalStorage.bind() captured inside                    | R1      |
| AsyncLocalStorage.snapshot() replayed outside               | R1      |
```

Fourteen of the seventeen carry the store. The three that lose it lose it because
the causal chain is broken, and `bind`/`snapshot` recover even those. An explicit
parameter reaches the first four rows and none of the rest without the app author
threading it.

## Library decision

Nothing external is involved, and nothing should be. `AsyncLocalStorage` is named
in Rule 1's preferred list as a Web/Node standard Bun implements natively, and the
measurements above say the native implementation costs 17.7 ns per scope, so
replacing it would be replacing the cheapest part of the system.

The Rule 1 position, stated outright: **an explicit context threaded as a
parameter is not a reimplementation of `AsyncLocalStorage`.** It is a different
mechanism with different semantics: `AsyncLocalStorage` propagates along the
async causality graph without the intermediate frames naming the value, and a
parameter propagates only where a signature carries it. Table 8 is the difference,
in fourteen rows. So the idea is admissible under Rule 1, and it is refused on
the numbers rather than on the rule. What Rule 1 **does** forbid, and what was
never on the table here, is a JavaScript context stack keyed on a promise hook or
a JSC internal: `bun:jsc` exposes no such internal, `createHook` is a stub, and
the only alternative surface Bun offers is `AsyncLocalStorage.snapshot`/`bind`,
which are `AsyncLocalStorage`.

## Public API

None. The ALS binding stays.

`RequestContext` keeps its three abstract members and `AsyncRequestContext` keeps
its `AsyncLocalStorage`, because the measured saving from a parameter is 21 to
39 ns per request over a change that is entirely inside
`AsyncRequestContext.runWithContext` and `AuthContext.run`. Widening
`Middleware.handle` and `Next` to carry a per-request object is a breaking change
to `@dunx/http`'s only extension point, and `@arkv/logger`'s `ContextStore` reads
its own ambient store internally, so an explicit `RequestContext` would stop
correlating the log lines that the binding at
`packages/infra/src/logger/module.ts:104` exists to correlate.

## Where it lives

The two changes are internal, and both stay where the store already is:

- `packages/core/src/logger/context.ts:73` -
  `AsyncRequestContext.runWithContext` builds `{ ...this.#storage.getStore(), ...context }`
  unconditionally. Reading the store first and passing `context` straight through
  when it is `undefined` measures 148.6 ns to 47.2 ns, and `undefined` is the case
  on every request, because `RequestLoggingMiddleware` is outermost. Nesting is
  unchanged at 228.0 against 215.9 ns.
- `packages/auth/src/context.ts:25` - `AuthContext` holds a second
  `AsyncLocalStorage`, and entering a second instance is the 200.6 ns row in table
  6B. Carrying the principal on the one store measures 363.7 ns to 26.0 ns. The
  reason the file gives for a second store is that `RequestFields` is serialised
  into every log line, and that reason survives. Measured (`bun p12-keys.ts`): a
  non-enumerable key is not copied by `{ ...getStore() }`, and a symbol key is
  copied but `JSON.stringify` drops it, so either keeps the principal out of the
  line that `ConsoleLogger` and `@arkv/logger` write.

Neither touches a signature. Both belong in `docs/architecture/cost-of-logging.md`,
whose "What still costs" section currently attributes 0.9 microseconds to
`AsyncLocalStorage`.

## What it refuses

- **A per-request carrier on `Middleware`.** `Next` is `() => Promise<Response>`
  and `RouteContext` is built once per route at boot and frozen
  (`packages/http/src/server/context.ts:25`, composed at `routes.ts:311`), so there
  is no per-request object to hang a field on. `directOr` at `routes.ts:218` skips
  `compose` entirely, so a carrier would need allocating there too.
- **`enterWith`.** Table 2. A process that calls it and then awaits does not survive.
- **A JavaScript context stack.** Table 4: there is no hook, no async id, and no
  `AsyncContext` global to build one on.
- **Dropping `getContext()`'s copy.** Returning the live store would remove 19 ns
  per log line (46.8 against 27.8 ns) and is a separate question, already open in
  `docs/architecture/cost-of-logging.md`, because `@arkv/logger`'s `ContextStore`
  implements the same signature.

## Risks and open spikes

- **`fix1` changes nested-scope semantics in one case.** With no enclosing store
  the `context` object is passed to `storage.run` by reference rather than copied,
  so `updateContext` inside the scope mutates the caller's object. The caller in
  `@dunx/http` builds a fresh literal per request
  (`packages/http/src/server/request-logging.ts:203`), so nothing observes it, but
  a test asserting the freshness would need to say which case it is asserting.
- **Folding the principal onto one store crosses a package boundary.**
  `AuthContext` would write a key that `RequestContext` owns, and it already writes
  `userId` there (`packages/auth/src/context.ts:61`), so the precedent exists. The
  key must be non-enumerable or a symbol, and that needs a test asserting it does
  not appear in a serialised log line.
- **Both fixes are `@arkv/logger`'s too.** `ContextStore.runWithContext` does the
  same merge, and dunx binds it as `RequestContext` whenever `@dunx/infra/logger`
  is imported, so an app on the real logger sees no saving until the same change
  ships upstream at `~/repos/arkv/packages/logger`. That is the Rule 1 path, and it
  must not be a local wrapper.
- **The two-source spread cost is a JSC characteristic, not a contract.** 112.9 ns
  against 21.9 ns on Bun 1.3.14. Re-measure on a Bun upgrade before treating the
  fix as load bearing.
- **`enterWith` is worth re-checking on a Bun upgrade** for the reason
  `docs/bun-apis.md` gives, but it would remove the callback and not the merge, so
  it is worth about 18 ns rather than the 0.91 microseconds that entry implies.
- **Unmeasured:** whether the same fixes move the `bun run logging` harness by the
  amount the microbenchmarks predict. The prediction is 0.10 to 0.34 microseconds
  per request, and the harness resolves about 0.5, so it may report nothing.

## Cost

**Call sites that change, if the explicit design were taken:** 15 ambient call
sites in `packages/*` plus 12 wiring sites that feed them, plus the middleware
contract itself. Ambient: `core/src/logger/context.ts:53,57,75,76`,
`core/src/logger/console.ts:176,203`, `auth/src/context.ts:41,46,61,62`,
`auth/src/guard.ts:86`, `http/src/server/request-logging.ts:216,294`,
`http/src/client/service.ts:152,397`. Wiring: `core/src/logger/console.ts:92`,
`core/src/di/app.ts:23,25`, `http/src/server/request-logging.ts:163`,
`http/src/server/factory.ts:55`, `http/src/client/service.ts:96`,
`http/src/client/module.ts:48`, `auth/src/context.ts:27`, `auth/src/module.ts:52`,
`auth/src/guard.ts:58`, `infra/src/logger/module.ts:104,116`, all under
`/home/petarzarkov/repos/dunx/packages/`. Outside `packages/*`: 4 sites in
`examples/full/src/auth/audit.service.ts` and the same 4 in
`tools/create-app/templates/features/auth/audit.service.ts`, 2 in `internal/bench`,
and 86 matching lines across 8 test files.

**Call sites that change for the two fixes taken instead:** two.
`packages/core/src/logger/context.ts:73` and `packages/auth/src/context.ts:25`
with its `run` at `:62`. No signature moves, so no test outside those two files
changes, and `RequestContext` implementors are unaffected.

**Migration path for an existing app.** None for the fixes: the observable
behaviour of `getContext()`, `updateContext()`, `runWithContext()`,
`AuthContext.current()` and `AuthContext.require()` is unchanged, and a service
five hops down keeps reading the store with no reference to the request. Under the
explicit design, every service reading `AuthContext.current()` or
`RequestContext.getContext()` takes the scope as a parameter, and so does every
method between it and the handler.

**Breaking change to a published package.** The fixes are not: no exported type,
signature or documented behaviour changes, and the version bump is a patch. The
explicit design would be a major on `@dunx/http` (`Middleware.handle` and `Next`),
`@dunx/core` (`RequestContext`) and `@dunx/auth` (`AuthContext`), and would also
need `@arkv/logger` to grow a non-ambient read path before an app on
`@dunx/infra/logger` saw any of the saving.
