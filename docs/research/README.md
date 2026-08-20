# Research records

One file per investigated capability, holding the probe output, the comparison
tables and the argument behind a verdict. Written to be superseded.

The pipeline is research, then decision, then delivery:

- **`docs/research/`** answers "can this be built, on what, and what does it
  cost". A file stays here after the decision, because the measurements outlive
  it and a refusal needs its evidence kept.
- **`docs/roadmap/`** holds accepted open work, one file per item, deleted when
  delivered.
- **`docs/architecture/`** takes the measurements that survive delivery.

Every verdict below was produced against Bun 1.3.14 on one WSL2 machine, with
Node v24.18.0 where a comparison needed it. Numbers are from that machine.

## Verdicts

| Record                                                 | Verdict                | Owner                     | Blocked on                            |
| ------------------------------------------------------ | ---------------------- | ------------------------- | ------------------------------------- |
| [releases-subpages](./releases-subpages.md)            | build                  | `internal/docs`           | nothing                               |
| [scheduler](./scheduler.md)                            | **delivered**          | `@dunx/infra/schedule`    | nothing, shipped                      |
| [health](./health.md)                                  | **delivered**          | `@dunx/http`              | nothing, shipped as `OnBeforeShutdown` |
| [throttle](./throttle.md)                              | build                  | `@dunx/http`              | nothing, its blocker shipped          |
| [arkv-logger-context](./arkv-logger-context.md)        | build, additive        | `@arkv/logger` 0.11.0     | nothing                               |
| [arkv-logger-transports](./arkv-logger-transports.md)  | build, additive        | `@arkv/logger` 0.11.0     | nothing                               |
| [arkv-logger-serialization](./arkv-logger-serialization.md) | build the fused walk | `@arkv/logger`       | the equivalence gate                  |
| [async-context](./async-context.md)                    | refused, 2 fixes found | `@dunx/http`, `@dunx/auth` | nothing                              |
| [stats](./stats.md)                                    | collect, refuse exposition | `@dunx/http`, `@dunx/core` | memory reader moving to core     |
| [bun-primitives](./bun-primitives.md)                  | 2 adopt, 3 reject      | various                   | nothing                               |
| [rpc](./rpc.md)                                        | JSON-RPC later, gRPC no | `@dunx/http` `./rpc`      | MCP codec descending to `@dunx/http`  |
| [brokers](./brokers.md)                                | neither now            | `@dunx/infra/amqp` first  | an external issue                     |

[async-context-constraints](./async-context-constraints.md) holds that record's
verified facts alone, in the format
[architecture/constraints.md](../architecture/constraints.md) uses, ready to be
appended there once the record is reviewed.

All twelve records are in. Two of the six defects below have since been fixed and
two of the verdicts have shipped; the rows say which. The serialization one carries the logger performance
question, and it lands where
[arkv-logger-transports](./arkv-logger-transports.md) pointed: the write is 4 to 9
percent of a log call and entry assembly plus sanitization is the rest. A fused
walk that redacts while serializing is 3.09x on Bun and 1.69x on Node, 44 of 44
corpus payloads byte-identical.

## Defects found in shipped code

These are not features and do not wait on a roadmap decision.

1. ~~**`ClientAddress` trusts the wrong end of `X-Forwarded-For`.**~~ **Fixed.**
   It took `.split(',')[0]`, the leftmost entry, which is the one a client
   appends, so a caller could set its own address and bypass any IP-keyed limiter
   by rotating one header. `ClientAddress` now counts trusted hops from the right,
   `true` meaning one proxy, and clamps a count longer than the header to the
   leftmost entry. The setting is `app.set('trust proxy', n)`; the record below
   still spells it `trustProxy`. This unblocked [throttle](./throttle.md), which
   found it.
2. ~~**`@dunx/mcp` drops JSON-RPC batches.**~~ **Fixed.** A batch is an array with
   no `id`, so it fell through to the notification check and was answered with
   silence while the client held an outstanding id. `protocol.ts` now has a
   `rejection()` step ahead of that check which answers an array with `-32600`
   and a message naming the protocol revision. See [rpc](./rpc.md).

   **Correction to that record, and it is what the fix followed.**
   [rpc](./rpc.md) reads the absence of batch handling as the defect, which would
   have made implementing it the fix. MCP **removed** JSON-RPC batching in
   2025-06-18, listed first among that revision's major changes, and
   `PROTOCOL_VERSION` in the same file is `2025-06-18`. A batch is therefore not a
   request this server can answer, so the defect was the silence rather than the
   missing feature.
3. ~~**`@arkv/logger` loses buffered entries on SIGTERM.**~~ **Not a defect.**
   [arkv-logger-transports](./arkv-logger-transports.md) reports that a batched
   entry is lost on SIGTERM unless some handler is installed and that
   `captureGlobalErrors` installs none, which is true. It is also documented and
   deliberate: `packages/logger/README.md` states that installing a SIGINT or
   SIGTERM listener suppresses default termination, which is the host's decision
   and not a logger's, and tells the caller to call `logger.close()` from its own
   shutdown hook.

   dunx already does. `packages/infra/src/logger/module.ts:79-82` calls
   `logger.close()` from `onShutdown`, and `enableShutdownHooks` owns the signal at
   the application level, where the process is owned. So the chain closes: SIGTERM,
   `App.shutdown()`, `onShutdown`, `close()`, transports flush. The gap is only for
   someone using `@arkv/logger` standalone with `bufferBytes > 0` and no shutdown
   hook, which the README tells them to write.
4. **`ContextStore` is nominal, so `AsyncRequestContext` cannot be passed to
   `Logger`.** Its `private readonly asyncLocalStorage` field makes the class
   nominal, and `tsc` reports
   `TS2741: Property 'asyncLocalStorage' is missing in type 'AsyncRequestContext'`.
   Core's own contract implementation is rejected by the logger it exists to
   feed. See [arkv-logger-context](./arkv-logger-context.md).
5. **`findNestedError` walks a typed array element by element.** It runs on the
   caller's object before sanitization looking for an `Error`, and treated a typed
   array as a plain object. No element of one can be an `Error`. A 64 KiB
   `Uint8Array` cost 24 ms of blocked event loop per log call and a 1 MiB buffer
   cost 1,415 ms, so `logger.info('upload', { body })` stalled a service for over a
   second. One `ArrayBuffer.isView` guard. Found by
   [arkv-logger-serialization](./arkv-logger-serialization.md), which was looking
   for something else.
6. **`shouldMask` lowercases the whole mask list once per key.** A twenty-key entry
   did 160 `toLowerCase()` calls to produce eight distinct strings. Lowering once
   per entry is 1.94x through the sanitizer. Not a correctness defect, listed here
   because it sat in the same function as the one above.

## Findings for `docs/bun-apis.md`

Verified here, not yet recorded there. Each record holds the reproducer.

| Finding                                                                                  | Record          |
| ---------------------------------------------------------------------------------------- | --------------- |
| `Bun.cron` exists with an in-process callback overload and `Bun.cron.parse`               | scheduler       |
| `Bun.cron`'s `{ tz }` is silently ignored on 1.3.14, and a bogus zone id does not throw   | scheduler       |
| Bun 1.4 flips `Bun.cron`'s default from UTC to system local and starts honouring `tz`     | scheduler       |
| `Bun.inspect(err)` embeds a source excerpt of the throwing file, secrets included         | bun-primitives  |
| `beforeExit` fires only when the loop drained, so never for a listening server            | bun-primitives  |
| `Bun.peek.status` is `pending` for any async function that executed an `await`            | bun-primitives  |
| `Bun.unsafe` holds three functions, none a metric; `percentAvailableMemoryInUse` is null  | bun-primitives  |
| `jsc.heapStats()` costs 2.2 ms, `generateHeapSnapshot()` 11 to 15 ms                      | bun-primitives  |
| `await Bun.sleep(0)` resolves ahead of a queued `setTimeout(cb, 0)`                       | bun-primitives  |
| `AsyncLocalStorage.enterWith` crashes the process at teardown, exit 132                   | async-context   |
| `async_hooks.createHook` is a stub: callbacks never fire, `executionAsyncId()` is always 0 | async-context   |
| `storage.run(scope, fn)` costs 17.7 ns, and loading ALS deoptimises nothing process wide   | async-context   |
| `perf_hooks.createHistogram()` is a real native HDR histogram, `record()` at 10.7 ns      | stats           |
| passing explicit bounds to `createHistogram` costs 8 to 19x the memory                    | stats           |
| `monitorEventLoopDelay` is native and accurate, but misses a block in `enable()`'s turn    | stats           |
| no GC hook exists: `supportedEntryTypes` is mark, measure, resource                       | stats           |
| `v8.getHeapStatistics()` costs 1076 to 7606 us and two siblings throw `NotImplementedError` | stats         |
| `Bun.unsafe.mimallocDump()` writes to fd 2 and returns undefined, so it is not a metric    | stats           |
| `Bun.serve` speaks no HTTP/2 and `Response` carries no trailers                           | rpc             |
| `node:http2` hosts a working gRPC server, trailers included                               | rpc             |
| `http2.connect()` against an HTTP/1.1 origin leaks an uncatchable internal `TypeError`    | rpc             |
| `Bun.RedisClient.send('EVAL', ...)` runs Lua atomically and returns tables as arrays      | throttle        |
| `Bun.RedisClient.script()` exists at runtime but is undeclared in bun-types 1.3.14        | throttle        |
| Bun ships no Kafka and no AMQP client, and NAN addons cannot load against JSC             | brokers         |

One number to reconcile before either is copied across: `jsc.heapStats()` was
measured at 2.2 ms by [bun-primitives](./bun-primitives.md) and 7.04 ms by
[stats](./stats.md), on the same machine. It walks every live object, so the
likely cause is how much each harness had allocated first. The verdict is the
same at both figures, so nothing downstream turns on it.
| Timers above 2^31-1 ms are clamped to 1 ms and fire at 17 ms                              | scheduler       |

## Suggested order

Grouped by what unblocks what, cheapest first inside each group.

**First, the four defects above.** Each is small, none needs a design decision,
and two of them gate work below.

**Then the moves Rule 2 requires.** Only the first two are done ahead of a
consumer, because only they have one already. Rule 2's trigger is the second copy
appearing: `providersOf` and `modulesOf` descended into `@dunx/core` the moment
`@dunx/dashboard` was a second consumer, not before it. Moving a declaration
earlier means guessing the shared shape, and reshaping a published export twice.
So moves 3 and 4 land inside the features that need them, and are listed here to
be remembered rather than done first.

1. `OnDrain` in `@dunx/core`, run before `server.stop()`. Two consumers waiting:
   health, and the queue worker whose own comment at
   `packages/infra/src/queue/worker.ts:368` says "`App` has no hook to register
   against".
2. The marker-plus-prototype-scan walker into `@dunx/core`. `@Cron` would be its
   fourth copy.
3. **With health, item 9.** `ProbeState`, `ProbeResult`, `DashboardProbe` and
   `RedisProbe` from `@dunx/dashboard` down into `@dunx/http`, which health needs
   and the dashboard already peer-depends on. `DashboardProbe` wants a better name
   once two packages share it, and dashboard re-exports the old one.
4. **With stats, or with health, whichever lands first.** `MemoryReport` and the
   `process.memoryUsage()` reader from
   `packages/dashboard/src/api/runtime.ts:63-71`, its only shipped call site,
   down into `@dunx/core`, with `packages/dashboard/src/api/types.ts`
   re-exporting so `internal/dashboard-ui`'s relative `import type` is unchanged.
   Health and stats are the second and third consumers.
   `internal/bench`'s own histogram must **not** move: it crosses a Worker
   boundary as a `Uint32Array`. See [stats](./stats.md).

**Then the cheap wins**, in this order:

4. The releases sub-page. The router already parses the route; the change is one
   dispatch line, one component and one link.
5. `Bun.main` and runtime identity in the boot log line. Under 0.30 us, once.
6. The first async-context fix: skip the merge in
   `AsyncRequestContext.runWithContext` when no enclosing store exists, 148.6 ns
   to 47.2 ns on every request. Patch level, no public signature moved.
   `ContextStore` in `~/repos/arkv/packages/logger` performs the same merge and
   replaces the binding whenever `@dunx/infra/logger` is imported, so it has to
   ship upstream as well or the win is lost in any app with a logger.

   **The second fix is refused.** [async-context](./async-context.md) proposes
   folding the principal onto the one store instead of nesting a second
   `AsyncLocalStorage` in `AuthContext`, worth 363.7 ns to 26.0 ns on an
   authenticated request. `packages/auth/src/context.ts` documents why there are
   two: `RequestContext` is the log record, every field in it is serialized into
   every line the request writes, so a session object there is noise on each
   entry and a redaction hazard in the ones that matter. Only `userId` goes in,
   which is what correlates the lines without carrying the principal.

   A symbol-keyed field would survive `getContext()`'s spread while staying
   invisible to `JSON.stringify` and to any sanitizer walking string keys, so the
   win is technically reachable. It is not taken: 337 ns on authenticated
   requests is not worth cleverness on the path that decides who the caller is.
   Revisit only with a measurement showing it matters.
7. `@arkv/logger` 0.11.0: the context contract and the buffered transports. Both
   additive, both measured, and the context half fixes defect 4.

**Then the features**, in dependency order:

8. Scheduler, once the walker has moved.
9. Health, once `OnDrain` exists and the probes have moved.
10. Throttle, once `ClientAddress` counts hops.

**Deferred with stated triggers**, in [rpc](./rpc.md) and
[brokers](./brokers.md): JSON-RPC, RabbitMQ, Kafka, gRPC. None of them is
blocked by Bun except gRPC's mounting, and all four are held by
`docs/ROADMAP.md`'s rule that a new package needs a user first.

## Two decisions, both settled by the owner

1. **`@arkv/logger` is Node only.** No browser or edge target, which the manifest
   already said: `engines.node >= 18`, `nodejs` in `keywords`, and a description
   naming Node.js. So the context contract is taken for pluggability alone, and
   the `@arkv/logger/async-context` subpath sequence
   [arkv-logger-context](./arkv-logger-context.md) sketched as a follow-on is
   refused. `node:async_hooks` stays a plain top-level import.

   One consequence for `CLAUDE.md`, which currently states that `@arkv` "targets
   Node.js and the web": true of the workspace, not of this package. The
   constraint that survives is the CJS build, so no top-level `await` and no
   `import.meta`.

2. **The publish path creates a git tag and a GitHub release.** The release body
   carries that release's changelog section and links to
   `#/releases/<version>`. `scripts/changelog.ts` already parses `CHANGELOG.md`
   in both directions, so the section is read rather than reassembled.
   `ci.yml` is pinned by npm's OIDC trusted publishing, so its filename and the
   publish job's identity must not move.
