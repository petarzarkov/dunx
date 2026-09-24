# Logging

`@arkv/logger` bound to core's `Logger` contract, where a fix belongs when the boundary makes it ambiguous, and the request-logging design: one trace id, `correlateIgnored`, and the 500's stack.

## Colour in `@dunx/infra/logger`, and where the fix belongs

`LoggerModule.forRoot()` used to write ANSI escapes into its JSON whenever stdout was
not a terminal. That makes the logs unparseable for anything downstream. Measured:
with `Bun.enableANSIColors === false` and `process.stdout.isTTY === undefined`, a
default entry came out as `{\u001b[36m"level":\u001b[39m...`, 26 escapes in one line.
Neither `NO_COLOR=1` nor `FORCE_COLOR=0` suppressed it.

The cause is upstream and it is not an edge case. `@arkv/logger` picks the pretty
formatter from `isDevelopment`, which defaults to `process.env.NODE_ENV !== 'production'`.
**Nothing on the colour path asks whether the output is a terminal**, not the
logger, `ConsoleTransport`, or the formatter. So the zero-argument
`LoggerModule.forRoot()` in a container with `NODE_ENV` unset hit it. That went
beyond just an app that passed `isDevelopment: true`.

This split cleanly along the `@arkv` boundary: `@arkv` targets Node and the web, so
a Bun-specific improvement stays in dunx and a portable one goes upstream
([the rationale record](../../internal/notes/research/repo-rules-rationale.md#reuse-the-arkv-workspace---and-extend-it-upstream)).
Both halves were done rather than one:

- **dunx supplies the default, because the good answer is Bun-specific.**
  `isDevelopment` now defaults to `Bun.enableANSIColors`, which already folds in TTY
  detection, `NO_COLOR` and `FORCE_COLOR`. That is not a patch, a wrapper, or a
  vendored copy. It is dunx choosing the default for an option upstream exposes, and
  a consumer that passes `isDevelopment` explicitly still wins. `Bun.enableANSIColors`
  is also strictly the better question: upstream's option controls colour and
  nothing else, so `NODE_ENV` was never what it wanted to know.
- **The portable gate belongs upstream and stays there.** `@arkv` targets Node and
  the web, so it cannot use `Bun.*`. Its own `@arkv/colors` already exports
  `isColorSupported()`, and nothing in the logger calls it. That proposal shipped
  upstream in `@arkv/logger` 0.8.2, with the exact call site and a second defect it
  turned up: `FORCE_COLOR=0` is read as presence, so it forces colour _on_.

The two compose: once the upstream gate lands, dunx's default is still the right
one, and nothing here has to be undone. `packages/infra/src/logger/module.test.ts`
asserts the entry is coloured **exactly when** `Bun.enableANSIColors` is true. That
holds at a terminal and in a pipe, and fails on the old default.

### The second colour defect, also upstream, also fixed there

Reported from `dunx-template`'s own first two lines of output: the opening `{` of a
warning came out red, and the closing `}` took whatever colour the last value had.

`@arkv/logger`'s colouriser was a regex over the serialised JSON,
`/(".*?":\s*)(.*?)(?=,|\n|$)/g`, and **a regex cannot tokenise JSON**. Two consequences,
both visible in one line:

- A comma inside a string value ended the value early. The rest of the message was
  emitted **bare**, and the `","appId":` that followed was then matched as if it were
  a key.
- The lookahead has no `}`, so the last value's colour span ran to end of line and
  swallowed the closing brace.

The red `{` is the detail that matters: the obvious explanation is wrong. It
is not the terminal: **Bun wraps `console.error` output in red itself**, emitting
`\u001b[0m\u001b[31m` before the line and `\u001b[0m` after. Every token the formatter
colours overrides that wrapper. Every character it leaves bare keeps it. So the fix
has to tokenise and colour the punctuation too. Nothing did that before.

The fix is a scanner over `safeStringify`'s output rather than a re-serialisation.
Escapes are only ever _inserted_, so the stripped bytes stay byte-identical and a
pretty line stays parseable. That also gets every `JSON.stringify` edge case for
free: dropped `undefined`, `toJSON`, non-finite numbers, the circular fallback.

**Upstream, in `~/repos/arkv/packages/logger/src/format.ts`,** per Rule 1: it needs
no `Bun.*` API, and it is a defect every `@arkv/logger` consumer has. A local
wrapper would have forked a package the owner maintains.

## What else of `@arkv` dunx uses, and what it does not

| package           | in dunx                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@arkv/logger`    | Used, bound to core's `Logger` contract by `@dunx/infra/logger`.                                                                                                                                                |
| `@arkv/colors`    | Used, through the logger.                                                                                                                                                                                       |
| `@arkv/timezones` | Used by `@dunx/infra/schedule`: `getZone` validates a job's time zone (`packages/infra/src/schedule/options.ts`).                                                                                               |
| `@arkv/shared`    | Used by `@dunx/http`'s fetch client: `HttpService` extends `UrlHelper` for `buildUrl` and `interpolate` (`packages/http/src/client/service.ts`).                                                                |
| `@arkv/rng`       | **Not used.** It is WASM-backed, and dunx needs ids rather than statistics: `Bun.randomUUIDv7` and `crypto.randomUUID` are native and measured at 0.04 us, so adopting it would trade a native call for weight. |

**Backoff is not shared with `@arkv/shared`**, whose `retry` takes a constant delay
with no multiplier, jitter, cap, or signal. Where backoff lives in dunx:

- `packages/core/src/resilience/backoff.ts`: `backoffDelay`, exponential with
  jitter from `crypto.getRandomValues` and a cap, used by `ResiliencePolicy`.
- `packages/http/src/client/retry.ts`: the fetch client's `RetryClassifier`. It
  computes no delay of its own; it asks for a `Retry-After` wait, and
  `ResiliencePolicy` computes or caps the delay.
- `packages/http/src/ws/pubsub.ts`: the websocket relay's resubscribe doubles its
  own delay up to 30 s.
- `packages/infra/src/queue/processor.ts` rethrows a failed job, and bullmq applies
  its own retry and backoff.

**Redaction was the second.** `sanitizeLogEntry` is real and good, and as of
`@arkv/logger` 0.8.2 it is exported. dunx still does not consume it: `@dunx/core`
having zero dependencies is load-bearing, and `ConsoleLogger` not sanitizing is
the reason to swap in `@dunx/infra/logger`.

Three fixes went the other way, the direction the rule points in: a
colour-support gate, `FORCE_COLOR=0` no longer forcing colour _on_, and that
sanitizer export. All three shipped in 0.8.2 rather than being patched here.

## One correlation id, and it is W3C Trace Context

There is no second id beside `traceId`. Anything a service needs to correlate by
is in `traceparent` on the way in, in the async scope while the request runs, and
in `traceresponse` on the way out. A private id alongside it would be a second
value per line that always agreed with the first.

Three things about the shape are decisions rather than details:

- **Minting is 49.2 ns** for a trace id and a span id together, through
  `Uint8Array.prototype.toHex`, against 260.5 ns for a `crypto.randomUUID()` pair.
- **A malformed `traceparent` is discarded, not repaired**, which the standard
  requires and which is also the trust boundary: it is a caller-supplied string
  that reaches every line the request writes. An all-zero trace id, an all-zero
  span id and the reserved version `ff` are each rejected.
- **The response header is `traceresponse`**, carrying the span that answered. It
  is a W3C Distributed Tracing Working Group proposal rather than a ratified
  standard (the Trace Context Level 2 draft covers `traceparent` and `tracestate`,
  both request headers), so it is a specified format with thin adoption.
  `traceResponse: false` drops it.

The sampling decision travels as it arrived: `traceFlags` is in the scope and the
outbound client forwards it, so a trace an upstream sampler declined is not
re-sampled at this hop. `tracestate` is forwarded unchanged for the same reason.

With `OtelModule` bound and an SDK recording, the ids in the scope are the
exported span's rather than minted ones; the probe that settled it is under
"OpenTelemetry spans, on Bun 1.4.2" in [Verified constraints](./constraints.md#opentelemetry-spans-on-bun-142),
and the behaviour is in the [Tracing guide](../guide/31-tracing.md).

## `ignore` skips everything, and `correlateIgnored` buys back part of it

`ignore` returns `next()` before anything else happens, which makes it free. It
also means an ignored path has no `traceresponse` and no `AsyncLocalStorage`
scope, so a health check's own log lines are uncorrelated. Splitting `ignore` into
two lists was rejected: the cost is not the path list, it is the work, and a second
list would still not say which work. `correlateIgnored: boolean` names the work
instead.

On an ignored path it pays for the header read, the trace, the scope and one
`Headers.set`, and never for the entry, which is the expensive half (see
[the cost of request logging](./cost-of-logging.md)). Default `false`, so the
shipped hot path is unchanged.

## The 500's stack goes through the bound `Logger`

`defaultErrorMapper` used to write it with `console.error`. In a JSON-only service
that meant one structured entry from request logging plus a multi-line,
Bun-formatted dump that a collector reads as several broken records.
`errorMapper(logger)` is the implementation, and `HttpApplication` builds the
default from `app.get(Logger)`, so the stack lands in the same stream and the same
shape as everything else.

`defaultErrorMapper` remains as `errorMapper(new ConsoleLogger())` for
`buildRoutes`/`buildFallback` called directly, which have no container to ask.

The `Error` is passed as its own argument rather than as `{ err: error }` inside the
fields object, because `JSON.stringify(new Error('x'))` is `{}`: a field would drop
the stack, while every `Logger` implementation picks an `Error` argument out and
serialises it.
