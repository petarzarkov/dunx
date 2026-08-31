# The cost of request logging

Where the default path's microseconds go, why `write(2)` per entry is the largest single cost, and what batching trades away.

## Where the 4.8 us goes, measured without a socket, 2026-08-31

`bun run logging` resolves a step to about half a microsecond, and the section
below already records that six of its eleven steps land inside that. So the ladder
could say request logging costs +4.78 us without saying which part. `bun run
inproc` answers that: it drives `RequestLoggingMiddleware.handle` directly, one
variant per process, round-robin. A step there resolves to about 50 ns.

The floor row runs the same loop with no middleware, so every other row minus the
floor is what logging costs. That came to 4833 ns against the socket ladder's
4780 ns, which is the check that the rig measures the same thing.

| Step                                       | this step | running total |
| ------------------------------------------ | --------: | ------------: |
| the middleware chain                       |     +8 ns |          8 ns |
| the pathname sliced out of `req.url`       |    +50 ns |         57 ns |
| the `ignore` and `ignorePrefix` checks     |     +9 ns |         56 ns |
| `Bun.nanoseconds()`                        |    +71 ns |        106 ns |
| `x-request-id` read                        |    +75 ns |        181 ns |
| `crypto.randomUUID()`                      |   +147 ns |        328 ns |
| the scope object                           |     +9 ns |        337 ns |
| `runWithContext` around the handler        |   +144 ns |        481 ns |
| `user-agent` and the request object        |   +141 ns |        621 ns |
| `.then` and `x-request-id` on the response |   +616 ns |       1237 ns |
| the `logger.info` call                     |  +2900 ns |       4137 ns |

Two things in that table were not where anyone was looking. The `logger.info` call
is 60% of request logging on its own. The `.then` continuation plus one
`Headers.set` is 616 ns, the second largest item, and nothing has ever tried to
reduce it.

### The logger call, split further

| What the logger does                      | over doing nothing |
| ----------------------------------------- | -----------------: |
| take the arguments and discard them       |                  - |
| build the merged entry object             |           +1201 ns |
| serialise a two-key entry, about 40 bytes |           +1314 ns |
| build and serialise the entry, ~250 bytes |           +2656 ns |
| and write it, batched                     |           +2906 ns |

**The write is 97 ns of 4606.** Batching already took that cost, which is what
makes a worker thread the wrong tool here: `pino` moves the write off the main
thread with `thread-stream` and keeps serialising on it, and the thing that would
move is already paid for. Moving serialisation instead means `postMessage`, whose
structured clone costs more than the `JSON.stringify` it would replace.

### Rejected: a text format, and a compiled serialiser

Building the line was measured five ways against a `merge` control that runs
`ConsoleLogger`'s own line-building on the same dispatch and batching, so a row
differs from the control by one thing. Numbers are logging cost, floor subtracted:

| Variant                                           | ns/req | vs the control |
| ------------------------------------------------- | -----: | -------------: |
| the shipped `ConsoleLogger`                       |   4933 |         +97 ns |
| the `merge` control                               |   4836 |              - |
| `trim`, dropping `pid`, `flow` and `userAgent`    |   4574 |        -262 ns |
| `lean`, about 120 bytes rather than 250           |   4010 |        -826 ns |
| the same JSON built without a merged entry object |   4955 |        +119 ns |
| that JSON written out longhand                    |   4688 |        -148 ns |
| a serialiser compiled with `new Function`         |   5057 |        +221 ns |
| logfmt instead of JSON                            |   6213 |       +1377 ns |

Text is 28% dearer than the JSON it replaces. `JSON.stringify` is native, and no
per-key walk in JavaScript beats it. A serialiser compiled for the known shape,
which is the technique `pino` uses, is not faster either.

The reason every reformatting lands within a couple of hundred nanoseconds is that
the formatter was never the cost. A two-key entry of 40 bytes is 1342 ns cheaper
than the 250-byte one through the same `JSON.stringify`, so what is being paid for
is the size of the line and the objects behind it.

That leaves one lever, and it has a price rather than being free. `lean` buys 826
ns, 17% of request logging, by halving the entry: out go `method`, `event`,
`context` and `statusCode`, which `message` already spells as "GET /json 200".
Those are the fields a log pipeline filters and groups on, so the saving is
observability spent on throughput. `trim` keeps all of them and drops only `pid`,
`flow` and `request.userAgent`, and buys 262 ns against a standard deviation of
103 to 176, which is close enough to the noise to want the 5950X before believing
it.

### The header lever did not survive being measured

The socket ladder puts +0.97 us on the first touch of `req.headers`, which would
make it the second largest item on the path. In the rig above the two header reads
cost 216 ns together. Probed directly on `Bun.serve`, a handler reading one header
was within noise of one reading none.

The ladder's step is measured against its own +-0.5 us floor, and the section below
already records that one of its steps reads negative. Treat the +0.97 us as an
artifact until the 5950X says otherwise, and do not design an option around it.

### Getting to 80% of `bun-serve`, and what it costs

`results/latest.json` on the 5950X has `dunx-logging` at 60.6% of `bun-serve` on
plaintext and 61.8% on json. Reaching 80% means cutting 3.46 us and 3.29 us
respectively, which is 63% and 64% of what request logging costs.

Most of the line is the same on every request. `level`, `pid` and `flow` are
constant for the process; `method`, `event` and `context` are constant for the
route; `message` is "GET /json 200", so it is constant for the route and the
status together. Only the timestamp, the request id, the user agent and the
elapsed milliseconds vary. So the line can be cut into fragments once and roped
together per request, which is what the `precomp` rows do.

| Variant                                 | logging ns | saved | % of `bun-serve`, json |
| --------------------------------------- | ---------: | ----: | ---------------------: |
| the shipped path                        |       4665 |     - |                  61.8% |
| fragments, all twelve fields kept       |       3170 | 32.0% |                  69.7% |
| fragments, `request.userAgent` dropped  |       2844 | 39.0% |                  71.7% |
| build the line and never emit it        |       2280 | 51.0% |                      - |
| emit a **constant** line every request  |       1680 | 64.0% |                  79.9% |
| a five-field line, correlation given up |       1251 | 73.2% |                  83.3% |

The constant-line row is the bound worth keeping in mind: it does no per-request
work at all and still writes 250 bytes, and it lands at 64.0%. The 80% target sits
two points under that, so 80% is not a formatting problem and no faster serialiser
reaches it. What reaches it is writing less.

The last row does reach it, at 83.3%, and its bill is the whole feature set: no
`AsyncLocalStorage` scope, so nothing else the request logs carries its id; no
inbound `x-request-id` honoured and a process-local counter instead of a UUID, so
an id does not span two services; no `user-agent`; no `x-request-id` on the
response; and five fields where there were twelve.

Keeping every field that a log pipeline filters or groups on, the reachable figure
is **69.7% on json and 69.0% on plaintext**. Dropping only `user-agent` takes it
to 71.7% and 71.2%.

### `@dunx/infra/logger` costs twice what the benchmark measures

Every other figure here is `ConsoleLogger`, because that is what `internal/bench`
binds. Driven through the same rig, arkv's logger cost 10147 ns of request logging
against `ConsoleLogger`'s 4923. So an app on `@dunx/infra/logger`, which is the
configuration `packages/infra/README.md` recommends, sat near **46% of
`bun-serve`** rather than the 61.8% the benchmark reports. That had never been
measured.

It is consistent rather than surprising: arkv's own `bench.ts` put `Logger.info`
at 1474 ns against `ConsoleLogger`'s 543 in the same kind of tight loop. The extra
buys sanitization, async context and the transport stack.

**Fixed upstream**, in `~/repos/arkv`, since that is where a fix reaches the
owner's other projects. Two builds of the package compared in one process,
alternating by round:

| arkv operation           | before | after | change |
| ------------------------ | -----: | ----: | -----: |
| `Logger.info`            |   1474 |   959 | -35.0% |
| `Logger.info` in a scope |   1801 |  1260 | -30.0% |
| `Logger.error`           |   1995 |  1584 | -20.6% |
| `sanitizePrepared`       |    567 |   339 | -40.2% |
| `logfmtFormat`           |    921 |   812 | -11.9% |
| `serializeError`         |    526 |   473 |  -9.9% |
| `createLogEntry`         |    420 |   393 |  -6.5% |

What was in them, all allocation rather than algorithm:

- `sanitizePrepared` walked the entry through `safeEntries`, which is
  `Object.keys(obj).map((key) => [key, obj[key]])`: a pair array per key on top of
  the key array, so a twelve-field entry allocated fourteen arrays per call and
  discarded all of them.
- `extractErrorAndExtra` copied the caller's object field by field into a fresh
  `extra` that `createLogEntry` then spread again. Where there is one plain object
  and no error hiding in `err`/`error`, it is handed through instead.
- Two `...(x ? { x } : {})` spreads at the `createLogEntry` call site allocated an
  empty object each, on every call by a logger configured with neither.
- `serializeError` ran a global regex with an unused capture group over the whole
  stack, and allocated a `WeakSet` for a cycle check that only descending needs.
- `logfmt`'s `quote` ran four `replaceAll` passes over every quoted value; most
  are quoted for containing a space and have nothing for the other three to do.

In the dunx request path that is 10147 ns to 9117 ns, **-10.2%**. Less than the
35% the tight loop shows, for the reason the rest of this page keeps finding: what
was removed is short-lived nursery garbage, and the path is paced by the retained
strings.

Two things measured and **not** adopted, both recorded because the reasoning is
worth more than the change would have been:

- **`ContextStore.peekContext`.** The logger already prefers a copy-free read
  where the reader offers one, and `ContextStore` does not implement it. That is
  deliberate upstream: the class is public and subclassable, and a subclass
  overriding `getContext` to redact a field would be silently bypassed. The prize
  is one shallow spread, about 22 ns.
- **Batching `ConsoleTransport`.** It is implemented and opt-in, and no throughput
  win was reproducible for it: 10267 ns unbatched against 11106 ns batched with
  stdout on /dev/null, 22.9 us against 23.8 us into a pipe nobody drains. A write
  to /dev/null costs about 100 ns, so there is little to save, and against a
  blocked consumer the limit is bytes rather than calls. An earlier single
  measurement said 889 ns and did not survive being repeated.

### The fragment approach needs the middleware and the logger co-designed

`nomerge`, `aot` and `fastjson` all left `ConsoleLogger` to build the line from
what `logger.info(message, fields)` was handed, and all three landed within a few
hundred nanoseconds of the shipped path. The saving in the `precomp` rows comes
from the middleware not building the `fields` object and not calling
`JSON.stringify` at all, which the current contract has no way to express.

That matters for who benefits. A fast path only `ConsoleLogger` implements helps
the default logger and this benchmark; an app on `@dunx/infra/logger` keeps the
generic path, because `@arkv/logger` cannot take an already-serialised line and
still redact it. A leaner entry, by contrast, is worth 5% to 17% and is worth it
to every logger.

### Designing `logger.bind(shape)`, and what measuring it said

The fragment rows above need the middleware and the logger co-designed, so the
shape proposed for that was a bound writer: the caller declares the entry's shape
once, the logger compiles what is per-shape, and a request passes values
positionally instead of building an object.

`@arkv/logger`'s transports each format for themselves. `Transport.write(entry,
level)` hands over the entry and lets the transport render it, which is what lets
one console be coloured while a file beside it stays plain JSON. A bound writer
therefore cannot hand over a pre-serialised line; it has to produce the entry
object. The `bound` row measures exactly that: the caller's fields object gone,
the `getContext()` copy gone, the merge gone, `JSON.stringify` still there.

| Variant                                  | logging ns | saved |
| ---------------------------------------- | ---------: | ----: |
| the shipped path                         |       4621 |     - |
| `bound`, the entry object built directly |       4362 |  5.6% |
| `precomp`, fragments and no object       |       3289 | 28.8% |

**So a bound writer is worth 5.6%, and the merge was never the cost.** Building a
twelve-key object costs about what merging two spreads into one costs, and `bound`
still builds it. Only the fragment rows escape the object, and they escape the
generic `JSON.stringify` with it. The gap between the two rows, 1073 ns of the
1332 available, is what `Transport.write(entry, level)` costs.

That splits the design in two, and only the second half is worth anything.

**A bound writer alone** would still be a real API: mask decisions resolved per
field name once instead of per entry, reserved-name collisions raised at bind time
rather than filed per entry, and a declared primitive type letting `makeSafeForJson`
be skipped behind a `typeof` guard that falls back when the value is not what was
declared. That last part matters: a `trusted` flag would be a hole in redaction,
where a declared type is checkable. All of it buys 5.6%.

**A bound writer that emits a line** needs `Transport` to grow an optional
`writeLine(line, level)`, and it can only be used when every transport offers one
and would have rendered the same bytes. In practice that means exactly one
transport whose formatter is the one the writer compiled for, and fragments are
JSON, so `jsonFormat` and nothing else. That is narrower than it sounds and also
the production default: `new Logger({})` outside development is one
`ConsoleTransport` writing `jsonFormat`.

Two behaviours would have to survive it, and both are cheap rather than hard. The
async store can hold keys the shape does not declare, and today they reach the
line, so the writer has to compare what the store holds against what it compiled
for and fall back per entry when they differ. And an error is per-call and cannot
be compiled at all, so `error` stays on the generic path.

What it is worth, end to end: 28.8% of request logging, which is 61.8% of
`bun-serve` to about 69.7%. Not the 80% that started this, which needs the
five-field line and the loss of correlation recorded above.

**Not built.** Two repos, a new contract in each, a fast path that applies to one
transport and one formatter, and a fallback per entry to keep behaviour, for eight
points of a benchmark. The 5.6% version is not worth a public API at all. Recorded
here so the next person costs it from these numbers rather than from the guess this
started as.

### What this rig cannot see

There is no socket under it, so it prices the middleware and the logger and
nothing about `Bun.serve`'s own request handling. Anything lazy on a real
`BunRequest` is already materialised on the pooled `Request` objects it drives,
which is why the header question needs the socket harness and got the answer above
instead.

Three measurement traps are worth keeping, because each produced a confident wrong
answer first.

A `for` loop of `await`s never lets the macrotask queue run, so the batched
writer's flush never fires. Measured: 50,000 emits produced zero flushes and a
10 MB pending rope, and every row was then scored on how fast it grew a rope.

Yielding with `setTimeout(resolve, 0)` replaces that with a different artifact.
Bun clamps a zero timeout to about a millisecond, which put every row at 21 us of
idle timer. `setImmediate` is the yield that measures the work.

Measuring several loggers in one process is the third. The shared `handle` and
`info` call sites go polymorphic and the rows contaminate each other, seen here as
a 1.8 us swing on identical code between two orderings.

These runs are from a 12700H under WSL2, where the socket ladder cannot be read at
all: a full run put `default` ahead of `unbatched` and a blocked pipe ahead of
`/dev/null`, both impossible. `--only` was added to `bun run logging` so a
comparison can hold five units up rather than nineteen.

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
before either half is read and ~20 µs once one is. The second buffer and the
second `JSON.parse` are 0.32 µs together, and putting the body in the entry is
0.27 µs.

**So the expensive part was never the parsing, which is where everyone looks.**
For a JSON route declaring a `body` schema, `RawBody` records the buffered text
when request-body logging is enabled. Only an unvalidated route still clones.
The old figure was right about the old code and only ever described the
unvalidated case.

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

`bun run logging` is the third harness. It exists because `dunx-logging` in the
main suite was **one number for at least eight different things**. It sat at 40-45%
of raw `Bun.serve` while `dunx` sat at 90-98%, so dunx's _default_ configuration -
the one nearly every user runs - cost more than half the throughput, and nothing
said which half.

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
**2.68 µs/request** more than the same writer into `/dev/null`. Subjects now write
to `/dev/null` (`StdoutSink` in `src/subject-process.ts`), which is a real
`write(2)` that can never block. The blocked-pipe case survives as an explicit row
rather than as the default. The docstring in `servers/dunx-logging.ts` claimed the
harness drained that pipe; it never did.

### Where the time went

Every row is the same app on the same `GET /json` route, one step further along the
default path than the row above it. Measured **after** the changes below; the noise
floor is about ±0.5 µs, so three of these steps are not resolvable at all.

| Step                                             | adds     |
| ------------------------------------------------ | -------- |
| one middleware that only calls `next()`          | +0.05 µs |
| the pathname sliced out of `req.url`             | +0.73 µs |
| `x-request-id` and `user-agent` read             | +1.29 µs |
| `crypto.randomUUID()`                            | +0.04 µs |
| `runWithContext` around the handler              | +0.91 µs |
| `x-request-id` set on the response               | −0.04 µs |
| the entry object, the timings, `Logger` dispatch | +0.80 µs |
| `new Date().toISOString()`, cached per ms        | +0.17 µs |
| building and serialising the line                | +2.05 µs |
| the write, batched                               | −0.62 µs |

Three suspicions were wrong, recorded here as wrong:

- **`crypto.randomUUID()` is free.** 0.04 µs, an order of magnitude under the noise
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
materialises the whole header map, and the inbound `x-request-id` is part of the
contract, so it is irreducible), the **`AsyncLocalStorage` scope** (0.91 µs, the
mechanism that makes a handler's own log lines carry `requestId`), and **building
and serialising the entry** (2.05 µs, most of it `JSON.stringify`).

### The write was the largest single component, and batching removed it

One `console.log` per request measured **+1.24 µs** against not writing at all -
more than the `JSON.stringify` that produced the line. `ConsoleLogger` now
concatenates entries at `info` and below into one string and writes it once per
event-loop turn. The write becomes **unmeasurable** (−0.62 µs against the
serialise-only row, i.e. inside the noise floor). It also largely defuses the
blocked-pipe case: with batching an unread pipe costs 1.16 µs instead of 2.68.

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
string concatenation is a rope and pays almost nothing. Only the _flush_ is a
write, and once per turn it does not matter which API performs it. The flush goes
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
stays synchronous. The scope callback passed to `runWithContext` is now a plain
function using `.then` rather than an `async` arrow.

This is the same fault the input reader had, found the same way, and an
isolated probe puts an `async` scope callback at 0.44 µs over a synchronous
one. The pathname and the query string now come out of **one** pair of
`indexOf` calls instead of scanning `req.url` twice.

**`ConsoleLogger` has a fast path for `logger.info(string, object)`**, the
shape every framework call has. The general path spends two array allocations (the
rest parameter, then `[message, ...rest]`), a third object and an `Object.assign` to
reach an entry the fast path builds as one literal. The timestamp is cached by
millisecond: at any rate worth logging, `Date.now()` has not moved since the
previous entry. `new Date().toISOString()` measured ~170 ns.

### Rejected: skipping the entry when the level would drop it

`Logger` exposes `logLevel`, so `RequestLoggingMiddleware` could check at
construction whether `info` survives and skip building the `request` object. It was
not done. The default level _is_ `info`, so the gate never fires in the
configuration being optimised. A 4xx logs at `warn` and a 5xx at `error`, both of
which need the same `request` object, which is not known until after `next()`
resolves. The branch would add a field and a condition to buy nothing on the
default path.

### Rejected: a cheaper request id

Covered above - `crypto.randomUUID()` measured at 0.04 µs, and a counter-based id
would trade an unmeasurable saving for leaking request volume in a header that is
returned to the caller.

### An inbound `x-request-id` is validated rather than trusted

It used to be `req.headers.get(REQUEST_ID_HEADER) ?? crypto.randomUUID()`, so
`curl -H 'x-request-id: MY-OWN-ID'` was echoed on the response and written into
every line the request produced. That is a caller-supplied string on a trust
boundary: it can carry a newline, be a megabyte long, or be set to somebody else's
trace id knowingly. `nestjs-template` ran `isUuid()` on it first. dunx adopted the
same check, the accepted shape matching what this middleware mints.

Any UUID version passes; the check reads the layout rather than the version nibble, because
an upstream service minting v7 is not a threat model. The order matters more than
the regex: `inbound !== null` first, then `length === 36`, then the pattern. The
common request carries no header at all and pays one comparison. Measured in
isolation at 2M iterations, validating a present header costs **~40 ns** and the
no-header path is unchanged - two orders of magnitude below the ±0.5 µs the harness
can resolve, and below the `crypto.randomUUID()` call that follows it either way.

### `ignore` skips everything, and `correlateIgnored` buys back the half worth having

`ignore` returns `next()` before anything else happens, which makes it free. It
also means an ignored path has no `x-request-id` and no `AsyncLocalStorage`
scope, so a health check's own log lines were uncorrelated, and guide 12 claimed
the id was "always set on the response". Splitting `ignore` into two lists was
rejected: the cost is not the path list, it is the work, and a second list would
still not say which work. `correlateIgnored: boolean` names the work instead.

On an ignored path it pays for the header read, the id, the scope and one
`Headers.set` - the four rows above that sum to ~2.2 µs of the ~5.4 the full
path costs, and never for the entry, the expensive half. Default
`false`, so the shipped hot path is unchanged.

### The 500's stack goes through the bound `Logger`

`defaultErrorMapper` wrote it with `console.error`. In a JSON-only service that
means one structured entry from request logging plus a multi-line, Bun-formatted
dump that a collector reads as several broken records. A custom `onError` was
the only way to suppress it. `errorMapper(logger)` is now the real
implementation, and `HttpApplication` builds the default from `app.get(Logger)`,
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
contract: an inbound `x-request-id` has to be honoured and a handler's own log
lines have to carry the id. The third is the one with room left, and the
obvious move - hand-rolling a serialiser instead of `JSON.stringify` - is a
JavaScript reimplementation of a platform primitive with string escaping to get
wrong.

One real saving is available and blocked on a contract:
`RequestContext.getContext()` returns a copy, and `ConsoleLogger` then spreads
that copy into the entry, so the request fields are copied twice per line.
Removing one copy means either changing what `getContext()` returns - which
`@arkv/logger`'s `ContextStore` also implements - or changing the order of the
keys in every log line.
