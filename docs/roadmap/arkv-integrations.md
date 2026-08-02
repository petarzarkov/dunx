# What to send upstream to `@arkv`

> **All three proposals are implemented and open as
> [arkv#4](https://github.com/petarzarkov/arkv/pull/4).** A PR rather than a push,
> because pushing arkv's `main` publishes to npm and those packages are used by
> other projects. Merge when a release is wanted, then bump `@arkv/logger` here.
> Everything below is the analysis that produced it, kept because the reasoning is
> what makes the diff reviewable.

The workspace at `~/repos/arkv` was read end to end against the
question CLAUDE.md actually asks: is dunx doing something worse than a package the
owner already maintains?

**Nothing to adopt.** What came back instead is a short list of things to fix
upstream, which is the other direction the rule points in. Improvements go into the
`@arkv` repo and come back as a version bump - never a local patch or a vendored copy.

## Adoption: closed, with the two standing candidates answered

| package           | status in dunx                                                                                                                                                                                      |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@arkv/logger`    | Used. `@dunx/infra/logger` binds it to core's `Logger` contract.                                                                                                                                    |
| `@arkv/colors`    | Used, through the logger.                                                                                                                                                                           |
| `@arkv/timezones` | Mandated for any date or zone handling. No such need has arisen.                                                                                                                                    |
| `@arkv/rng`       | Mandated for ids and sampling. dunx uses `Bun.randomUUIDv7` and `crypto.randomUUID`, both native and measured at 0.04 us. `@arkv/rng` is WASM-backed, so switching trades a native call for weight. |
| `@arkv/shared`    | Not used. 15 runtime symbols, each 5-40 lines; dunx has a need for none of them.                                                                                                                    |

The rest of the workspace is out of scope by construction: `@arkv/nestjs-context-logger`
and `@arkv/nestjs-cms` are NestJS packages, and `@arkv/module-cost` publishes a `bin`
with no `exports`, `main` or `types`, so nothing in it is importable at all.

**Backoff: dropped, and the premise was wrong twice.** This file used to say doubling
backoff was implemented twice, in the relay's resubscribe and the queue's retry. It is
implemented **once**, at `packages/http/src/ws/pubsub.ts:124`. The queue does not
retry: bullmq does, through its own `attempts` and `backoff`, and ARCHITECTURE.md's
"Queues" is explicit that a dunx implementation of that would be a worse one. There
is nothing upstream to share with: `@arkv/shared`'s `retry`
(`packages/shared/src/async/async.utils.ts:4`) takes a **constant** `delayMs` with no
multiplier, jitter, cap, `AbortSignal` or predicate, and a workspace-wide grep for
`backoff|jitter|exponential|circuit` returns zero hits. One call site and no upstream
implementation is not a case for either.

**Redaction: closed, do not adopt even if the export lands.** The sanitizer is real and
good - `sanitizeLogEntry` at `packages/logger/src/sanitize.ts:242`, with the ten bug
fixes dunx already sent upstream in 0.8.0. It is also unreachable: not re-exported from
`logger/src/index.ts`, and `logger/package.json`'s `exports` map has only `.` and
`./testing`, so `@arkv/logger/sanitize` does not resolve even though `dist/esm/sanitize.js`
ships. That is worth fixing upstream (proposal C), but **core still must not take it**.
`@dunx/core` having zero dependencies is load-bearing, and `ConsoleLogger` not
sanitizing is deliberate - it is the reason swapping in `@dunx/infra/logger` is worth
doing. A sanitizer in core would cost the dependency and remove the reason.

Also confirmed absent from the whole workspace, so none of these is an option: id
generation, a sampling gate, env parsing, string casing, deep merge, LRU, semaphore or
async pool, circuit breaker, duration or byte formatting, assertions.

## Proposal A - gate the colour path on `isColorSupported()`

**The one with a live defect behind it.** `@arkv/logger` writes ANSI escapes into its
JSON when stdout is not a terminal, which makes the output unparseable. It is not
limited to `isDevelopment: true`: the default is `process.env.NODE_ENV !== 'production'`,
so a container with `NODE_ENV` unset hits it too. Measured on the installed 0.8.1 with
`Bun.enableANSIColors === false` and `process.stdout.isTTY === undefined`: 26 escapes in
one entry, and neither `NO_COLOR=1` nor `FORCE_COLOR=0` suppressed any of them.

Nothing on the path checks. `packages/logger/src/logger.ts:45-46,60-64` chooses
`prettyFormat` from `isDevelopment` and `packages/logger/src/transport.ts:35-36` chooses
it again from `pretty`; `prettyFormat` (`format.ts:23-24`) then calls `@arkv/colors`
unconditionally.

The fix is one line, at `packages/logger/src/format.ts:23-24`:

```ts
export const prettyFormat: LogFormatter = (entry, level) =>
  isColorSupported() ? formatColoredJson(entry, level) : safeStringify(entry);
```

That site rather than the two `pretty` decisions, because `transport.ts:36` is
`options.format ?? (pretty ? ...)` and `logger.ts:62` passes `format:` explicitly - so
gating the decisions means editing both and still missing an explicit
`format: prettyFormat`.

`isColorSupported` is already exported from `@arkv/colors`
(`packages/colors/src/detect.ts:9`) and is portable: no `Bun.*`, no `import.meta`, no
top-level await, so it survives the CJS build. It costs one `process.env` lookup per
entry; memoising it needs an explicit reset export or tests cannot change the
environment.

Note for whoever takes it: `packages/logger/src/testing.ts:1,10` already strips ANSI
before parsing, which is plausibly why this was never noticed upstream.

**dunx is not waiting on this and is not patching it.** `@dunx/infra/logger` now
defaults `isDevelopment` to `Bun.enableANSIColors`, which is the Bun-specific half and
therefore stays on the dunx side by the same rule. The two compose; nothing has to be
undone when A lands. See architecture/logging.md, "Colour in `@dunx/infra/logger`".

## Proposal B - `FORCE_COLOR=0` currently forces colour on

`packages/colors/src/detect.ts:12` tests for presence, not value:

```ts
if ('FORCE_COLOR' in process.env) return true;
```

So `FORCE_COLOR=0`, the conventional way to turn colour off, turns it on. Fix is
value-based: `0`, `false` or empty means `false`, anything else `true`. Ships with A or
A is still wrong for that one variable.

## Proposal C - export the sanitizer

Add `./sanitize` to `packages/logger/package.json`'s `exports` map, or re-export
`sanitizeLogEntry` and `findNestedError` from `logger/src/index.ts`. `dist/esm/sanitize.js`
is already built and shipped; only the map is missing, so this is a packaging fix rather
than a feature. Lowest priority of the three, and per the section above dunx will not
consume it - it is worth doing because shipping a file no consumer can import is a
defect on its own terms.

## Optional D - an API question, not a bug

`LoggerConfig.isDevelopment` controls colour and nothing else - three occurrences in the
package, all on the formatter choice - yet reads as a general environment flag. A
`colors?: boolean` defaulting to `isDevelopment && isColorSupported()` would give
consumers the independent switch that today requires replacing the whole `transports`
array, and would let dunx drop `isDevelopment: false` from its own tests.

## Versions this was measured against

`@arkv/logger` **0.8.1** installed, **0.8.0** in the source checkout; the two dists are
byte-identical on the colour path, so the proposals apply to the source as it stands.
`@arkv/colors` 0.7.4, `@arkv/shared` 0.8.0.
