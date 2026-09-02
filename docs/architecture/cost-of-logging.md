# The cost of request logging

Where the default path's microseconds go, why `write(2)` per entry is the largest single cost, and what batching trades away.

## Re-measured on Bun 1.4.0, 2026-08-22

### The body options, which this harness could not reach until it had a POST ladder

`requestBody: true` was documented as costing "roughly two thirds of the throughput"
and **no harness row could reproduce that**, because every row here runs `GET /json`
and a `GET` has no body. `bun run logging:bodies` adds a ladder on `POST /validate`;
`internal/bench/README.md` renders it.

| Setting                              | µs/req | vs the default |
| ------------------------------------ | -----: | -------------: |
| `requestLogging: false`              |  12.80 |       -4.45 µs |
| the shipped default, both bodies off |  17.25 |              - |
| `requestBody: true`, schema route    |  19.12 |       +1.87 µs |
| `responseBody: true`                 |  19.80 |       +2.55 µs |
| both bodies, schema route            |  20.03 |       +2.78 µs |
| `requestBody: true`, **no** schema   |  46.06 |      +28.81 µs |

The two request-body rows differ by one `Request.clone()`. Decomposed on raw
`Bun.serve`, cloning a request whose body is an unread network stream costs ~8 µs
before either half is read and ~20 µs once one is; the second buffer and the second
`JSON.parse` are 0.32 µs together, and putting the body in the entry is 0.27 µs.

**So the expensive part was never the parsing, which is where everyone looks.** A
route declaring a `body` schema now has its buffered text handed to the logger
through `RawBody`, and only an unvalidated route still clones. The old figure was
right about the old code and only ever described the unvalidated case.

### The default path, re-measured

Everything below this section was measured on Bun 1.3.14 and is kept, because most of
it is the record of what a **dunx** code change was worth rather than what Bun does.
Re-running `bun run logging` on 1.4 moved three of its conclusions.

| Figure                                              | 1.3.14   | 1.4.0    |
| --------------------------------------------------- | -------- | -------- |
| the whole default path, over logging off            | +5.38 µs | +4.78 µs |
| first touch of `req.headers`                        | +1.29 µs | +0.97 µs |
| the `AsyncLocalStorage` scope                       | +0.91 µs | +0.24 µs |
| building and serialising the entry                  | +2.05 µs | +1.77 µs |
| batching, against a `console.log` per entry         | -0.62 µs | -2.40 µs |
| `dunx-logging` as a fraction of `bun-serve`, `json` | 52.9%    | 59.3%    |

Three things changed:

- **The `AsyncLocalStorage` scope stopped being expensive.** It was the third-largest
  item and one of the three things named below as what actually costs. At +0.24 µs it
  is inside the ±0.5 µs floor. `requestLogging: { correlate: false }` therefore buys
  nothing measurable, which is recorded in `docs/guide/13-logging.md`.
- **Batching became the largest single saving on the path**, worth 2.40 µs against
  4.78 µs total, and 4.19 µs when the consumer is slow. The section below argues that
  a `write(2)` per entry was the worst of it; on 1.4 that is more true, not less.
- **The step-to-step ladder is at the harness floor.** Six of eleven steps land inside
  ±0.5 µs and one reads **negative** (`crypto.randomUUID()` at -0.30 µs). Read the
  total; a single row is not a measurement.

The two things that did not change: the **first touch of `req.headers`** is still the
largest non-entry step, and **building and serialising the entry** is still the
largest step overall before the write.

## The cost of request logging on Bun 1.3.14 (`internal/bench` logging harness)

`bun run logging` is the third harness, and it exists because `dunx-logging` in the
main suite was **one number for at least eight different things**. It sat at 40-45%
of raw `Bun.serve` while `dunx` sat at 90-98%, so dunx's _default_ configuration -
the one nearly every user runs - cost more than half the throughput, and nothing said
which half.

`servers/logging/dunx.ts` is one app whose middleware is truncated at a step chosen
by `$LOGGING_VARIANT`, plus three stand-in `Logger` bindings that stop after the
entry, after the timestamp, and after `JSON.stringify`. Rows are brought up together
and measured **round-robin**, for the reason the validation harness records.

Where `dunx-logging` ended up, as a fraction of raw `Bun.serve` in the same run:

| Scenario    | before | after |
| ----------- | -----: | ----: |
| `plaintext` |  41.7% | 55.7% |
| `json`      |  40.1% | 52.9% |
| `params`    |  39.5% | 54.5% |
| `validate`  |  48.1% | 63.1% |

**Two of those points are a harness fix and the rest are code, and the split is worth
being explicit about.** Measured as overhead over `requestLogging: false` on the
`json` route: the old code into `/dev/null` cost **+10.51 µs**; the new code
unbatched costs **+7.24 µs**; the new code as shipped costs **+5.38 µs**. So the
structural changes are worth ~3.3 µs and batching ~1.9 µs. Separately, the pipe the
harness never drained was worth 2.68 µs on top of that with an unbatched writer, and
that was never dunx's cost at all.

### The harness was measuring the pipe rather than the framework

Before anything else: `startSubject` spawned every subject with `stdout: 'pipe'` and
**nothing ever read it**. 64 KiB in, the pipe is full, and the server parks on every
subsequent write until the kernel finds room. Seven of the eight subjects log
nothing, so only `dunx-logging` ever hit it - the one row where it mattered.

Measured, on the `json` scenario: an unbatched writer into an unread pipe cost
**2.68 µs/request** more than the same writer into `/dev/null`. Subjects now write to
`/dev/null` (`StdoutSink` in `src/subject-process.ts`), which is a real `write(2)`
that can never block, and the blocked-pipe case survives as an explicit row rather
than as the default. The docstring in `servers/dunx-logging.ts` claimed the harness
drained that pipe; it never did.

### Where the time went

Every row is the same app on the same `GET /json` route, one step further along the
default path than the row above it. Measured **after** the changes below; the noise
floor is about ±0.5 µs, so three of these steps are not resolvable at all.

| Step                                             | adds     |
| ------------------------------------------------ | -------- |
| one middleware that only calls `next()`          | +0.05 µs |
| the pathname sliced out of `req.url`             | +0.73 µs |
| `traceparent` and `user-agent` read              | +1.29 µs |
| minting the correlation ids                      | +0.04 µs |
| `runWithContext` around the handler              | +0.91 µs |
| the correlation header set on the response       | −0.04 µs |
| the entry object, the timings, `Logger` dispatch | +0.80 µs |
| `new Date().toISOString()`, cached per ms        | +0.17 µs |
| building and serialising the line                | +2.05 µs |
| the write, batched                               | −0.62 µs |

The three id rows were measured while the middleware minted a UUID request id.
`TraceContext.adopt` replaced that and is cheaper - 49.2 ns for a trace id and a
span id together, against 260.5 ns for `crypto.randomUUID()` plus a span - so all
three are upper bounds now.

Three suspicions were wrong, recorded here as wrong:

- **Minting the id is free.** 0.04 µs, an order of magnitude under the noise
  floor, and 90 ns in a hot loop. A per-process prefix plus a counter would save
  nothing measurable and would leak how many requests the process has served.
- **Losing the direct dispatch path costs nothing measurable.** A bare
  `next()`-only middleware is 0.05 µs. The 6 points that path is worth on `params`
  do not reappear as a cost here, because the request is already paying for
  everything else.
- **`response.headers.set` is free**, despite an isolated `Bun.serve` probe putting
  it at 0.70 µs. The isolated probe was measuring a different baseline; the harness
  is the arbiter.

What actually costs: **the first touch of `req.headers`** (1.29 µs - Bun
materialises the whole header map, and the inbound `traceparent` is part of the
contract, so it is irreducible), the **`AsyncLocalStorage` scope** (0.91 µs, which is
what makes a handler's own log lines carry `traceId`), and **building and
serialising the entry** (2.05 µs, most of it `JSON.stringify`).

### The write was the largest single component, and batching removed it

One `console.log` per request measured **+1.24 µs** against not writing at all - more
than the `JSON.stringify` that produced the line. `ConsoleLogger` now concatenates
entries at `info` and below into one string and writes it once per event-loop turn,
and the write becomes **unmeasurable** (−0.62 µs against the serialise-only row, i.e.
inside the noise floor). It also largely defuses the blocked-pipe case: with batching
an unread pipe costs 1.16 µs instead of 2.68.

Things that were measured and did **not** work, all in a real `Bun.serve` handler:

| Strategy                                       | vs no write |
| ---------------------------------------------- | ----------- |
| `console.log(line)`                            | +1.84 µs    |
| `process.stdout.write(line + '\n')`            | +1.44 µs    |
| `process.stdout.write(encoder.encode(line))`   | +1.43 µs    |
| `Bun.stdout.writer({ highWaterMark: 64 KiB })` | +1.37 µs    |
| the same sink at 4 KiB                         | +1.86 µs    |
| batch into an array, flush on a **microtask**  | +1.48 µs    |
| concatenate, flush on a **macrotask**          | +0.27 µs    |

**`Bun.stdout.writer()` is the Bun-native API and it lost**, the one place
this work preferred a library to the platform primitive. A `FileSink.write()`
encodes into its own
buffer on every call, so it pays per entry exactly what it was meant to save; a JS
string concatenation is a rope and pays almost nothing. Only the _flush_ is a write,
and once per turn it does not matter which API performs it - so the flush goes
through `console.log`, which is also what keeps `console` interception working in
tests.

**Microtask batching does not batch.** Microtasks drain after essentially every
request, so the batch size is one and the cost is the same as writing directly. The
macrotask turn is what lets Bun accumulate a real batch.

### The durability trade, and what bounds it

A line still sitting in the buffer is lost if the process dies without unwinding - a
`SIGKILL`, an OOM kill, a segfault - which is exactly when a log matters most. Three
things bound it, and they are asserted in `packages/core/src/logger/console.test.ts`:

- **`warn`, `error` and `fatal` are never buffered.** They go out immediately _and_
  flush everything queued behind them, so the entries you go looking for after a
  crash - and everything that led up to them - were never held back. This is what
  makes the trade acceptable rather than merely fast.
- The window is **one event-loop turn** rather than a timer interval.
- `flush()` is public, `onShutdown()` calls it so the container flushes on a
  graceful stop, and `process.on('exit')` catches the rest.
- `new ConsoleLogger(context, level, false)` opts out entirely.

### The other two changes

**`request-logging.ts` has no `async` function left in it.** `#body` and
`#responseFields` were `async` and, with both body options off - the default -
they returned `{}` immediately, so every request paid two async frames and two
`await`s on values that were never promises. They now return `Promise<unknown>
| undefined`, where `undefined` means there is nothing to read and the caller
stays synchronous, and the scope callback passed to `runWithContext` is a plain
function using `.then` rather than an `async` arrow.

This is the same fault the input reader had, found the same way, and an
isolated probe puts an `async` scope callback at 0.44 µs over a synchronous
one. The pathname and the query string now come out of **one** pair of
`indexOf` calls instead of scanning `req.url` twice.

**`ConsoleLogger` has a fast path for `logger.info(string, object)`**, the
shape every framework call has. The general path spends two array allocations (the
rest parameter, then `[message, ...rest]`), a third object and an `Object.assign` to
reach an entry the fast path builds as one literal. The timestamp is cached by
millisecond: at any rate worth logging, `Date.now()` has not moved since the previous
entry, and `new Date().toISOString()` measured ~170 ns.

### Rejected: skipping the entry when the level would drop it

`Logger` exposes `logLevel`, so `RequestLoggingMiddleware` could check at
construction whether `info` survives and skip building the `request` object. It was
not done. The default level _is_ `info`, so the gate never fires in the configuration
being optimised; and a 4xx logs at `warn` and a 5xx at `error`, both of which need
the same `request` object, which is not known until after `next()` resolves. The
branch would add a field and a condition to buy nothing on the default path.

### Rejected: a cheaper id

Covered above - minting measured at 0.04 µs, and a counter-based id would trade an
unmeasurable saving for leaking request volume in a header returned to the caller.

### `x-request-id` was removed, and W3C Trace Context replaced it

The two did the same job and only one of them is a standard. `requestId` was a
UUID minted per request, validated on the way in and echoed on the way out;
`traceId` is 32 hex digits carried in `traceparent`, understood by every
OpenTelemetry collector, and already had to be minted alongside it once tracing
existed. Carrying both meant two correlation ids per line that always agreed.

What the removal cost, and what it bought:

- **Minting got cheaper.** `Uint8Array.prototype.toHex` produces a trace id and a
  span id in **49.2 ns**, against **260.5 ns** for `crypto.randomUUID()` plus a
  `getRandomValues(8)` span. `toHex` exists on Bun 1.4.0 and typechecks under the
  root tsconfig's `lib: ESNext`.
- **The trust boundary moved rather than disappearing.** An inbound `x-request-id`
  was validated as a UUID because it is a caller-supplied string that reaches every
  line the request writes. `traceparent` gets the stricter version of the same
  treatment, and the standard specifies it: a malformed header is **discarded, not
  repaired**, and an all-zero trace id, an all-zero span id and the reserved
  version `ff` are each rejected.
- **The response header changed from `x-request-id` to `traceresponse`**, W3C Trace
  Context Level 2, carrying the span that answered. Same purpose, same wire cost, a
  specification behind it.
- **A bug went with it.** The outbound client hardcoded `flags: '01'` when building
  `traceparent`, so a trace an upstream sampler had declined was re-sampled at every
  dunx hop. `traceFlags` is in the async scope now and forwarded as it arrived,
  which is why `RequestFields` gained a fourth trace field.

`@dunx/http` exports no `REQUEST_ID_HEADER` and `@dunx/http/client` no
`propagateRequestId`. There is no compatibility shim: two ids that always agreed is
exactly the thing being removed.

### `ignore` skips everything, and `correlateIgnored` buys back the half worth having

`ignore` returns `next()` before anything else happens, which makes it
free and also means an ignored path has no `traceresponse` and no
`AsyncLocalStorage` scope - so a health check's own log lines were
uncorrelated, and guide 12 claimed the id was "always set on the response".
Splitting `ignore` into two lists was rejected: the cost is not the path list,
it is the work, and a second list would still not say which work.
`correlateIgnored: boolean` names the work instead.

On an ignored path it pays for the header read, the trace, the scope and one
`Headers.set` - the four rows above that sum to ~2.2 µs of the ~5.4 the full
path costs, and never for the entry, the expensive half. Default
`false`, so the shipped hot path is unchanged.

### The 500's stack goes through the bound `Logger`

`defaultErrorMapper` wrote it with `console.error`. In a JSON-only service that
is one structured entry from request logging plus a multi-line, Bun-formatted
dump that a collector reads as several broken records, and a custom `onError`
was the only way to suppress it. `errorMapper(logger)` is now the real
implementation and `HttpApplication` builds the default from `app.get(Logger)`,
so the stack lands in the same stream and the same shape as everything else.

`defaultErrorMapper` remains as `errorMapper(new ConsoleLogger())` for
`buildRoutes`/`buildFallback` called directly, which have no container to ask.

The `Error` is passed as its own argument rather than as `{ err: error }` inside the
fields object, because `JSON.stringify(new Error('x'))` is `{}` - a field would drop
the stack, while every `Logger` implementation picks an `Error` argument out and
serialises it. This is the same class of bug as the `err` field in request
logging's own entry, so the mapper's line earns its place alongside it.

### What still costs

The remaining ~5.4 µs over `requestLogging: false` is **~1.3 µs of
`req.headers`, ~0.9 µs of `AsyncLocalStorage`, ~2.1 µs of entry construction
and `JSON.stringify`**, and ~0.7 µs of reading `req.url`. The first two are the
contract: an inbound `traceparent` has to be honoured and a handler's own log
lines have to carry the trace. The third is the one with room left, and the
obvious move - hand-rolling a serialiser instead of `JSON.stringify` - is a
JavaScript reimplementation of a platform primitive with string escaping to get
wrong.

One real saving is available and blocked on a contract:
`RequestContext.getContext()` returns a copy, and `ConsoleLogger` then spreads
that copy into the entry, so the request fields are copied twice per line.
Removing one copy means either changing what `getContext()` returns - which
`@arkv/logger`'s `ContextStore` also implements - or changing the order of the
keys in every log line.
