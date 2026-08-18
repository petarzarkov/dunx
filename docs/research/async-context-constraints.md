**Loading `node:async_hooks` deoptimises nothing process-wide.** Measured on Bun
1.3.14 with one subprocess per condition, 7 interleaved repetitions, and a
synchronous-call control that no condition can affect. Per-op nanoseconds for an
async function 5 awaits deep, median over subprocesses:

```
| condition                              | median ns | vs none |
| none (async_hooks never imported)      |    437.00 |    0.0% |
| import-only (imported, nothing built)  |    408.91 |   -6.4% |
| constructed (new ALS, never run)       |    419.92 |   -3.9% |
| ran-once (one als.run, then exited)    |    400.78 |   -8.3% |
| ran-1000 (1000 als.run, then exited)   |    523.31 |   19.7% |
| inside-store (workload inside als.run) |    432.49 |   -1.0% |
| createHook({...}).enable()             |    425.91 |   -2.5% |
```

The control swings -10.2% to +5.4% across the same conditions, so the noise band
is about plus or minus 11%. `ran-1000` re-run alone at 15 interleaved repetitions
gives 408.02 ns against `none`'s 390.73 ns with per-subprocess ranges of
341.1..542.0 and 319.7..529.3, which overlap.

**There is no `async_hooks` switch in Bun to trip.** `createHook` is a stub: its
callbacks never fire, `executionAsyncId()` and `triggerAsyncId()` are always `0`,
and `new AsyncResource('X').asyncId()` is `0`.

```
createHook init callbacks fired: 0  before: 0
executionAsyncId(): 0 triggerAsyncId(): 0
AsyncResource asyncId(): 0 triggerAsyncId(): 0
```

`AsyncLocalStorage.snapshot()` and `AsyncLocalStorage.bind()` do work, and both
replay a captured store outside its scope. `bun:jsc` exposes no async context
primitive (36 exports: GC, heap, sampling profiler, JIT controls, serialize,
setTimeZone), `Bun.unsafe` is `arrayBufferToString`, `gcAggressionLevel`,
`mimallocDump`, and `globalThis.AsyncContext` is `undefined`.

**`AsyncLocalStorage.run` costs 17.7 ns; the propagation across an await costs
nothing measurable.** Synchronous loop, 200,000 calls per batch, 51 batches:

```
| als.getStore(), no store active              |       3.3 ns |
| storage.run(scope, fn)                       |      17.7 ns |
| storage.run(scope, () => storage.getStore()) |      22.2 ns |
```

An async chain wrapped in `als.run` against the identical chain unwrapped,
interleaved batch by batch, paired delta: 1 await +26.5 ns, 5 awaits +2.9 ns,
20 awaits -166.5 ns. The delta does not grow with depth and changes sign.

**A two-source object spread costs 5 to 6 times a one-source spread.** Bun 1.3.14,
a 5-key object:

```
| {...scope}                (1 source)  |      21.9 ns |
| {...undefined, ...scope}  (2 sources) |     112.9 ns |
| {...other, ...scope}      (2 sources) |     131.7 ns |
| Object.assign({}, other, scope)       |     111.7 ns |
| explicit 5-key literal                |      16.6 ns |
```

**Entering a second `AsyncLocalStorage` instance while one is live costs 10 times
the first entry, and re-entering the same instance costs 5 times.**

```
| a.run(scope, fn)                                 |      18.8 ns |
| a.run(scope, () => a.run(scope, fn))   same inst |     102.1 ns |
| a.run(scope, () => b.run(scope, fn))   2nd inst  |     200.6 ns |
```

Nesting N distinct instances scales worse than re-entering one: 16 distinct
instances reach 3516.9 ns (219.8 ns per level, rising with depth), one instance
re-entered 16 times reaches 890.1 ns (55.6 ns per level, flat).

**`AsyncRequestContext`'s per-request cost is the object copying, not the store.**
The shipped shape, `runWithContext` plus one `getContext()`, measures 157 to 193 ns
across four runs; with `AuthContext.run` nested inside it, 367 to 424 ns. Passing
the same fields as a parameter and reading them twice measures 32 to 36 ns. Two
changes that keep `AsyncLocalStorage`:

```
| shipped: run({...getStore(), ...ctx})               |     148.6 ns |
| skip the merge when getStore() is undefined         |      47.2 ns |
| pass ctx as a parameter                             |       8.6 ns |
| shipped authed: 2 instances nested                  |     363.7 ns |
| one store, principal set after entry                |      26.0 ns |
```

With an enclosing store present, the skip-the-merge form is 215.9 ns against the
shipped 228.0 ns.

**`AsyncLocalStorage.enterWith()` survives a `setTimeout` and segfaults on an
`await`.** Reproduced on 1.3.14, extending the existing `bun-apis.md` entry.

```
enterWith(1); then 100000 more enterWith, no await   -> getStore() 99999, exit 0
enterWith(7); setTimeout(cb, 1)                      -> cb sees 7, exit 0
enterWith(1); await Promise.resolve()                -> panic(main thread): Segmentation fault, exit 132
als.run(i, async fn), 300000 iterations              -> correct store 300000/300000
als.run(42, ...) + microtask/queueMicrotask/setTimeout -> all see 42
```

**An ambient store reaches 14 of 17 read sites in one request's async tree.** One
`als.run('R1')` scope, Bun 1.3.14:

```
| where the store is read                                     | store   |
| sync frame, after 1 await, after Bun.sleep(1)               | R1      |
| after a setTimeout promise, after queueMicrotask            | R1      |
| EventEmitter listener registered outside, emitted inside    | R1      |
| field initializer of a class constructed inside the scope   | R1      |
| method on a singleton constructed at boot                   | R1      |
| ReadableStream pull() on a stream made inside               | R1      |
| inside a Promise.all branch, setInterval callback           | R1      |
| third-party callback, called on a later turn                | R1      |
| singleton field initializer at boot, no request active      | LOST    |
| callback stored inside, invoked outside the scope           | LOST    |
| queued inside, drained on a later turn outside              | LOST    |
| AsyncLocalStorage.bind() captured inside                    | R1      |
| AsyncLocalStorage.snapshot() replayed outside               | R1      |
```

**A JavaScript load generator on this machine cannot resolve a 100 to 300 ns
per-request term.** Five context strategies behind a 5-middleware `Bun.serve`
chain, timed inside the server at concurrency 4, 30,000 measured requests, 5
interleaved runs, produced `als-bare` (4860 ns p50) above `als` (4196 ns) and
`hybrid` (7861 ns) above both, which are impossible orderings. The `min` column
keeps the ordering: `als` 1202 ns against `explicit object` 1088 ns. The
in-process measurement is what resolves this size of term.

**A non-enumerable key is not copied by object spread, and a symbol key is copied
but not serialised.** Bun 1.3.14:

```
spread copies the symbol key: true
spread copies the non-enumerable key: false
JSON.stringify(copy):  {"requestId":"r"}
JSON.stringify(store): {"requestId":"r"}
```
