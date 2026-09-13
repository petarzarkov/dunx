# Research records

One file per investigated capability, holding the probe output, the comparison
tables and the argument behind a verdict. Written to be superseded.

The pipeline is research, then decision, then delivery:

- **`internal/notes/research/`** answers "can this be built, on what, and what does it
  cost". A file stays here while its measurements outlive the decision, which is what
  a refusal needs and what a shipped feature no longer does: once the runtime findings
  are in [bun-apis.md](../../../docs/bun-apis.md) and the design is in
  `docs/architecture/`, the record is deleted rather than marked done.
- **`internal/notes/roadmap/`** holds accepted open work, one file per item, deleted when
  delivered.
- **`docs/architecture/`** takes the measurements that survive delivery.

Every verdict below was produced against Bun 1.3.14 on one WSL2 machine, with
Node v24.18.0 where a comparison needed it. Numbers are from that machine.

## Verdicts

| Record                                                 | Verdict                | Owner                     | Blocked on                            |
| ------------------------------------------------------ | ---------------------- | ------------------------- | ------------------------------------- |
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
[architecture/constraints.md](../../../docs/architecture/constraints.md) uses, ready to be
appended there once the record is reviewed.

Eight records are left. The scheduler, health, throttle and releases sub-page records
were deleted on delivery, their Bun findings folded into
[bun-apis.md](../../../docs/bun-apis.md); git history holds the probes. Two of the six
defects below have since been fixed. The serialization one
carries the logger performance question, and it lands where
[arkv-logger-transports](./arkv-logger-transports.md) pointed. The write is 4 to
9 percent of a log call, and entry assembly plus sanitization is the rest. A fused
walk that redacts while serializing is 3.09x on Bun and 1.69x on Node, 44 of 44
corpus payloads byte-identical.

## Defects found in shipped code

These are not features and do not wait on a roadmap decision.

1. ~~**`ClientAddress` trusts the wrong end of `X-Forwarded-For`.**~~ **Fixed.**
   It took `.split(',')[0]`, the leftmost entry, which is the one a client
   appends. So a caller could set its own address and bypass any IP-keyed
   limiter by rotating one header. `ClientAddress` now counts trusted hops from the right,
   `true` meaning one proxy, and clamps a count longer than the header to the
   leftmost entry. The setting is `app.set('trust proxy', n)`; the record below
   still spells it `trustProxy`. The throttle record found it, and was unblocked
   by it.
2. ~~**`@dunx/mcp` drops JSON-RPC batches.**~~ **Fixed.** A batch is an array with
   no `id`, so it fell through to the notification check. It was answered with
   silence while the client held an outstanding id. `protocol.ts` now has a
   `rejection()` step ahead of that check which answers an array with `-32600`
   and a message naming the protocol revision. See [rpc](./rpc.md).

   **Correction to that record, and it is what the fix followed.**
   [rpc](./rpc.md) reads the absence of batch handling as the defect, which would
   have made implementing it the fix. MCP **removed** JSON-RPC batching in
   2025-06-18, listed first among that revision's major changes.
   `PROTOCOL_VERSION` in the same file is `2025-06-18`. A batch is therefore not a
   request this server can answer, so the defect was the silence rather than the
   missing feature.
3. ~~**`@arkv/logger` loses buffered entries on SIGTERM.**~~ **Not a defect.**
   [arkv-logger-transports](./arkv-logger-transports.md) reports that a batched
   entry is lost on SIGTERM unless some handler is installed, and that
   `captureGlobalErrors` installs none. Both are true. It is also documented and
   deliberate: `packages/logger/README.md` states that installing a SIGINT or
   SIGTERM listener suppresses default termination, which is the host's decision
   and not a logger's. It tells the caller to call `logger.close()` from its own
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
   `Uint8Array` cost 24 ms of blocked event loop per log call, and a 1 MiB buffer
   cost 1,415 ms. So `logger.info('upload', { body })` stalled a service for over
   a second. One `ArrayBuffer.isView` guard. Found by
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
| Bun ships no Kafka and no AMQP client, and NAN addons cannot load against JSC             | brokers         |

One number to reconcile before either is copied across: `jsc.heapStats()` was
measured at 2.2 ms by [bun-primitives](./bun-primitives.md) and 7.04 ms by
[stats](./stats.md), on the same machine. It walks every live object, so the
likely cause is how much each harness had allocated first. The verdict is the
same at both figures, so nothing downstream turns on it.

## One fix reachable and refused

[async-context](./async-context.md) proposes folding the principal onto the one store
instead of nesting a second `AsyncLocalStorage` in `AuthContext`, worth 363.7 ns to
26.0 ns on an authenticated request. `packages/auth/src/context.ts` documents why there
are two: `RequestContext` is the log record, and every field in it is serialized into
every line the request writes. So a session object there would be noise on each entry,
and a redaction hazard in the ones that matter. Only `userId` goes in, which is what
correlates the lines without carrying the principal.

A symbol-keyed field would survive `getContext()`'s spread while staying invisible to
`JSON.stringify` and to any sanitizer walking string keys, so the win is technically
reachable. It is not taken: 337 ns on authenticated requests is not worth cleverness on
the path that decides who the caller is. Revisit only with a measurement showing it
matters.

**Deferred with stated triggers**, in [rpc](./rpc.md) and [brokers](./brokers.md):
JSON-RPC, RabbitMQ, Kafka, gRPC. None of them is blocked by Bun except gRPC's mounting,
and all four are held by `docs/ROADMAP.md`'s rule that a new package needs a user
first.

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
   `/releases/<version>`. `scripts/changelog.ts` already parses `CHANGELOG.md`
   in both directions, so the section is read rather than reassembled.
   `ci.yml` is pinned by npm's OIDC trusted publishing, so its filename and the
   publish job's identity must not move.
