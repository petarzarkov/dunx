# The cost of request logging

Where the default path's microseconds go, what batching the write trades away, and which levers were measured and rejected.

## Where the 4.8 us goes, measured without a socket, 2026-08-31

`bun run logging` resolves a step to about half a microsecond, and six of its
eleven steps land inside that (see **Earlier measurements**). So the ladder could
say request logging costs +4.78 us without saying which part.
`bun internal/bench/inproc-driver.ts` answers that: it drives
`RequestLoggingMiddleware.handle` directly through `inproc.ts`, one variant per
process, round-robin. A step there resolves to about 50 ns.

The floor row runs the same loop with no middleware, so every other row minus the
floor is what logging costs. That came to 4708 ns against the socket ladder's
4780 ns, which is the check that the rig measures the same thing.

**These figures come from one run of twenty-eight variants**, floor 1153 ns, seven
rounds, the variant order rotated by round. Assembling these tables
from several runs is what put two contradictory write costs on this page and a
running total that disagreed with its own steps: the machine drifts by more than
most of these rows are worth, so a number is only comparable to the numbers
measured beside it.

| Step                                        | this step | running total |
| ------------------------------------------- | --------: | ------------: |
| the middleware chain                        |    +13 ns |         13 ns |
| the pathname sliced out of `req.url`        |    +20 ns |         33 ns |
| the `ignore` and `ignorePrefix` checks      |    +13 ns |         46 ns |
| `Bun.nanoseconds()`                         |    +97 ns |        143 ns |
| `traceparent` read                          |    +80 ns |        223 ns |
| `TraceContext.adopt`                        |   +151 ns |        374 ns |
| the scope object                            |    +28 ns |        402 ns |
| `runWithContext` around the handler         |   +100 ns |        502 ns |
| `user-agent` and the request object         |   +143 ns |        645 ns |
| `.then` and `traceresponse` on the response |   +676 ns |       1321 ns |
| the `logger.info` call                      |  +3387 ns |       4708 ns |

The running total is the measured figure and the step is the difference between
two of them, so the column adds up rather than carrying a rounding error per row.
Three steps differ by 1 ns from what the driver prints for the same run,
which rounds both columns independently; standard deviations here run 17 to 141 ns.

Two things in that table were not where anyone was looking. The `logger.info` call
is 72% of request logging on its own. The `.then` continuation plus one
`Headers.set` is 676 ns, the second largest item, and nothing has ever tried to
reduce it.

### The logger call, split further

| What the logger does                    | over doing nothing |
| --------------------------------------- | -----------------: |
| take the arguments and discard them     |                  - |
| build the merged entry object           |           +1155 ns |
| build and serialise it, about 250 bytes |           +2270 ns |
| and write it, batched                   |           +2555 ns |

So the object is 1155 ns, `JSON.stringify` over it 1115, and **the write 285 ns of
4708**, which is 6% of request logging. Batching already took that cost, and that
is what makes a worker thread the wrong tool: `pino` moves the write off the main
thread with `thread-stream` and keeps serialising on it, so the half that would
move is the half already paid for. Moving serialisation instead means
`postMessage`, whose structured clone costs more than the `JSON.stringify` it
would replace.

### Rejected: a text format, and a compiled serialiser

Building the line was measured five ways against a `merge` control that runs
`ConsoleLogger`'s own line-building on the same dispatch and batching, so a row
differs from the control by one thing. Numbers are logging cost, floor subtracted:

| Variant                                           | ns/req | vs the control |
| ------------------------------------------------- | -----: | -------------: |
| the shipped `ConsoleLogger`                       |   4823 |         +20 ns |
| the `merge` control                               |   4803 |              - |
| `trim`, dropping `pid`, `flow` and `userAgent`    |   4449 |        -354 ns |
| `lean`, about 120 bytes rather than 250           |   3943 |        -860 ns |
| the same JSON built without a merged entry object |   4912 |        +109 ns |
| that JSON written out longhand                    |   4998 |        +195 ns |
| a serialiser compiled with `new Function`         |   5013 |        +210 ns |
| logfmt instead of JSON                            |   6002 |       +1199 ns |

Text is 25% dearer than the JSON it replaces. `JSON.stringify` is native, and no
per-key walk in JavaScript beats it. A serialiser compiled for the known shape,
which is the technique `pino` uses, is not faster either.

The reason every reformatting lands within a couple of hundred nanoseconds is that
the formatter was never the cost. `lean` goes through the same `JSON.stringify`
and is 860 ns cheaper for writing about 120 bytes rather than 250, so what is being
paid for is the size of the line and the objects behind it.

That leaves one lever, and it has a price rather than being free. `lean` buys 18%
of request logging by halving the entry: out go `method`, `event`, `context` and
`statusCode`, which `message` already spells as "GET /json 200". Those are the
fields a log pipeline filters and groups on, so the saving is observability spent
on throughput. `trim` keeps all of them and drops only `pid`, `flow` and
`request.userAgent`, for 354 ns against standard deviations of 59 to 85.

`fastjson` is the row that moved most since it was first measured, from 148 ns
under the control to 195 ns over it, because four of its scope strings were being
interpolated raw. Escaping them costs what the row was previously appearing to
save, which is its own answer to whether hand-rolled JSON is worth writing.

### The header lever did not survive being measured

The socket ladder puts +0.97 us on the first touch of `req.headers`, which would
make it the second largest item on the path. In the rig above the two header reads
cost 224 ns together, 80 for `traceparent` and 144 for `user-agent` with the
request object built around it. Probed directly on `Bun.serve`, a handler reading one header
was within noise of one reading none.

The ladder's step is measured against its own +-0.5 us floor, and one of its steps
has read negative (see **Earlier measurements**). Treat the +0.97 us as an
artifact until the 5950X says otherwise, and do not design an option around it.

### Getting to 80% of `bun-serve`, and what it costs

`results/latest.json` on the 5950X has `dunx-logging` at 60.6% of `bun-serve` on
plaintext and 61.8% on json. Reaching 80% means cutting 3.46 us and 3.29 us
respectively, which is 63% and 64% of what request logging costs.

Most of the line is the same on every request. `level`, `pid` and `flow` are
constant for the process; `method`, `event` and `context` are constant for the
route; `message` is "GET /json 200", so it is constant for the route and the
status together. Only the timestamp, the trace, the user agent and the elapsed
milliseconds vary. So the line can be cut into fragments once and roped
together per request, which is what the `precomp` rows do.

| Variant                                 | logging ns | saved | % of `bun-serve`, json |
| --------------------------------------- | ---------: | ----: | ---------------------: |
| the shipped path                        |       4708 |     - |                  61.8% |
| fragments, all twelve fields kept       |       3266 | 30.6% |                  69.3% |
| fragments, `request.userAgent` dropped  |       2912 | 38.1% |                  71.4% |
| emit a **constant** line every request  |       1716 | 63.6% |                  79.7% |
| a five-field line, correlation given up |       1211 | 74.3% |                  83.8% |

The constant-line row is the bound worth keeping in mind: it does no per-request
work at all and still writes 250 bytes, and it lands at 63.6%, against the 63% and
64% the target needs. So 80% is not a formatting problem and no faster serialiser
reaches it. What reaches it is writing less.

The last row does reach it, at 83.8%, and its bill is the whole feature set: no
`AsyncLocalStorage` scope, so nothing else the request logs carries its trace; no
inbound `traceparent` honoured and a process-local counter instead of 16 random
bytes, so an id does not span two services; no `user-agent`; no `traceresponse` on
the response; and five fields where there were twelve.

Keeping every field that a log pipeline filters or groups on, the reachable figure
is **69.3% on json and 68.6% on plaintext**. Dropping only `user-agent` takes it
to 71.4% and 70.9%.

### `@dunx/infra/logger` costs about twice what the benchmark measures

Every other figure here is `ConsoleLogger`, because that is what `internal/bench`
binds. Driven through the rig above, arkv's logger cost 10147 ns of request logging
against `ConsoleLogger`'s 4923, so **about 2.06x**. Both numbers come from the same
run on the same machine, which is what makes the ratio worth stating.

**The ratio is measured; a percentage of `bun-serve` is not, and an earlier version
of this page gave one anyway.** It read 46%, reached by adding this laptop's arkv
figure to the 5950X's no-logging baseline, which sums two machines. The rig also
has no socket under it, and the giveaway is in the numbers already here: it puts
`ConsoleLogger` logging at 4923 ns where the 5950X's socket run implies 5100. A
slower machine measuring less is only possible because the rig leaves out what
`Bun.serve` itself does, so its absolute figures are a subset of the path rather
than the path.

The error also runs one way. A socket adds its cost to both loggers, and
`(10147 + s) / (4923 + s)` falls as `s` grows, so the true ratio through a socket
is below 2.06 and the true percentage is above the 46% that was published. It made
production look worse than it is.

What can be said is the ratio, and that `internal/bench` measures neither side of
it: there is no arkv subject in the socket harness, so the configuration
`packages/infra/README.md` recommends has never been benchmarked end to end. That
is the gap worth closing, on the 5950X, before any figure for it goes in a
sentence with a percent sign.

It is consistent rather than surprising: arkv's own `bench.ts` put `Logger.info`
at 1474 ns against `ConsoleLogger`'s 543 in the same kind of tight loop. The extra
buys sanitization, async context and the transport stack.

**Fixed upstream** rather than here, since that is where a fix reaches the other
projects using it: `petarzarkov/arkv#9`, released as **`@arkv/logger@0.13.0`**.
Two builds of the package compared in one process, alternating by round:

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

Through the same rig, before and after, that is 10147 ns to 9117 ns, **-10.2%**.
A relative figure from one machine and one rig, which is what a before-and-after
in the same harness supports; it is not a claim about a socket. Less than the 35%
the tight loop shows, for the reason the rest of this page keeps finding: what was
removed is short-lived nursery garbage, and the path is paced by the retained
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
| the shipped path                         |       4708 |     - |
| `bound`, the entry object built directly |       4368 |  7.2% |
| `precomp`, fragments and no object       |       3266 | 30.6% |

**So a bound writer is worth 7.2%, and the merge was never the cost.** Building a
twelve-key object costs about what merging two spreads into one costs, and `bound`
still builds it. Only the fragment rows escape the object, and they escape the
generic `JSON.stringify` with it. The gap between the two rows, 1102 ns of the
1442 available, is what `Transport.write(entry, level)` costs.

That splits the design in two, and only the second half is worth anything.

**A bound writer alone** would still be a real API: mask decisions resolved per
field name once instead of per entry, reserved-name collisions raised at bind time
rather than filed per entry, and a declared primitive type letting `makeSafeForJson`
be skipped behind a `typeof` guard that falls back when the value is not what was
declared. That last part matters: a `trusted` flag would be a hole in redaction,
where a declared type is checkable. All of it buys 7.2%.

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

What it is worth, end to end: 30.6% of request logging, which is 61.8% of
`bun-serve` to about 69.3%. Not the 80% that started this, which needs the
five-field line and the loss of correlation recorded above.

**Not built.** Two repos, a new contract in each, a fast path that applies to one
transport and one formatter, and a fallback per entry to keep behaviour, for seven
points of a benchmark. The 7.2% version is not worth a public API at all. Recorded
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

## Batching the write, and what it trades away

`ConsoleLogger` concatenates entries at `info` and below into one string and writes
it once per event-loop turn. On Bun 1.3.14 one `console.log` per request cost
+1.24 us against not writing at all, more than the `JSON.stringify` that produced
the line; batched, the write fell inside the noise floor. On the current rig it is
285 ns of 4708 (see **The logger call, split further**).

Two alternatives measured worse, in a real `Bun.serve` handler:

- **`Bun.stdout.writer()` lost**, the one place this work preferred another API to
  the Bun-native one. A `FileSink.write()` encodes into its own buffer on every
  call, so it pays per entry what it was meant to save; a JavaScript string
  concatenation is a rope. The flush goes through `console.log`, which also keeps
  `console` interception working in tests.
- **Microtask batching does not batch.** Microtasks drain after essentially every
  request, so the batch size is one. The macrotask turn is what lets a batch form.

A line still in the buffer is lost if the process dies without unwinding: a
`SIGKILL`, an OOM kill, a segfault. `packages/core/src/logger/console.test.ts`
asserts what bounds that:

- **`warn`, `error` and `fatal` are never buffered.** They go out immediately and
  flush everything queued behind them, so the entries read after a crash, and
  what led up to them, were never held back.
- The window is **one event-loop turn** rather than a timer interval.
- `flush()` is public, `onShutdown()` calls it, and `process.on('exit')` catches the
  rest.
- `new ConsoleLogger(context, level, false)` opts out entirely.

## Earlier measurements

Two earlier rounds, on Bun 1.3.14 and on Bun 1.4.0 (2026-08-22), are superseded by
the figures above. What they established:

- **The harness once measured the pipe.** Subjects were spawned with
  `stdout: 'pipe'` and nothing read it, so `dunx-logging` parked on a full pipe:
  2.68 us per request with an unbatched writer. Subjects now write to `/dev/null`
  (`StdoutSink` in `src/subject-process.ts`), and the blocked pipe is an explicit
  row.
- **The 1.3.14 code changes** took `dunx-logging` on `json` from 40.1% to 52.9% of
  raw `Bun.serve` in the same run: no `async` function left in
  `request-logging.ts`, the pathname and query from one pair of `indexOf` calls, a
  `ConsoleLogger` fast path for `logger.info(string, object)`, and a timestamp
  cached per millisecond.
- **The socket ladder's steps are at its floor.** On 1.4.0 six of eleven steps
  landed inside +-0.5 us and one read negative (`crypto.randomUUID()` at -0.30 us).
  Read its total; a single row is not a measurement.
- **The `AsyncLocalStorage` scope stopped being expensive** on 1.4.0: 0.91 us on
  1.3.14, 0.24 us on 1.4.0. Bun 1.4.1 then removed the per-`await` charge (6.5 ns to
  0; method in [bun-apis.md](../bun-apis.md)), so `requestLogging: { correlate:
false }` buys nothing measurable for a handler of any depth.
- **Request-body logging costs a `Request.clone()`, not a parse.** On a `POST`
  ladder (`bun run logging:bodies`, 1.4.0), `requestBody: true` added 1.87 us on a
  route declaring a `body` schema and 28.81 us on one without. Cloning an unread
  network stream costs about 8 us before either half is read and about 20 us once
  one is; the second buffer and `JSON.parse` are 0.32 us. For a JSON route with a
  `body` schema, `RawBody` records the buffered text, so only an unvalidated route
  still clones.
- **`@arkv/logger` 0.13.0** cut a nine-field entry from 4968 to 2197 ns against
  0.10.2, measured in one process alternating by round. `LoggerModule` still served
  23% fewer requests per second than `ConsoleLogger` on the same route, which is the
  price of sanitization.
- **Minting an id is free** (0.04 us), so a counter-based id would save nothing and
  would leak request volume in a header returned to the caller.
- **Skipping the entry when the level would drop it was rejected.** The default
  level is `info`, so the gate never fires in the configuration being optimised,
  and a 4xx or 5xx needs the same `request` object.
- **One saving is blocked on a contract.** `RequestContext.getContext()` returns a
  copy that `ConsoleLogger` spreads again, so request fields are copied twice per
  line. Removing one copy means changing what `getContext()` returns, which
  `@arkv/logger`'s `ContextStore` also implements, or changing key order in every
  log line.

The design decisions those rounds produced (W3C Trace Context as the one
correlation id, `correlateIgnored`, and the 500's stack routed through `Logger`)
are in [logging.md](./logging.md).
