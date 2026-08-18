# @arkv/logger: transports, write economics, durability

Scope: the `Transport` contract and everything from the bytes to the operating system.
Entry assembly, sanitization and output encodings belong to sibling agents.

Baseline: `bun test` in `packages/logger` passes today - 159 pass, 0 fail, 369 expects,
10 files, 169 ms. Node is present at v24.18.0; Bun is 1.3.14. `strace` is absent on this
WSL2 box, so write syscalls are counted from `/proc/self/io`'s `syscw` field, an exact
kernel counter rather than an inference.

## Verdict

**Batch the console destination as a new opt-in transport. Do not change the `Transport`
interface. The all-synchronous rule in types.ts survives, and the exit matrix is the
evidence.**

The measurement that dominates dunx does not dominate arkv, and that shapes everything
else. dunx's `ConsoleLogger` is a ~2.5 microsecond logger in which one `write(2)` cost
1.84 microseconds, so the write was most of the call. `@arkv/logger` 0.10.0 is a **9.517
microsecond** logger on Node and **8.362** on Bun, of which the write is **0.821** and
**0.347** - **8.6% and 4.2%** - while entry assembly plus sanitization is 6.920 and 7.801,
**73% and 93%**.

Batching the write is worth 4.5x to 5.4x **on the write path**, 100x on syscalls, and
**1.00x end to end today**. The owner's performance target lives in the sanitizer, not
at the destination, and this plan should not be sold as the answer to it.

Batching still earns its place for two reasons that are not per-call latency:

- **Syscall economy.** One `write(2)` per entry becomes one per 100. At 20k entries per
  second that is 20,000 syscalls reduced to 200.
- **It is the only thing that defuses the full-pipe pathology**, where the two runtimes
  fail differently: Node queues 7.9 MB in memory, Bun blocks the event loop. Fewer,
  larger writes shrink both.

Ships: `BufferedConsoleTransport` and `StreamTransport`, both new files, no new
dependencies, no new optional peers. Refused: syslog, HTTP batching, OTLP,
`worker_threads`. This is a **minor** release (0.11.0).

One defect found on the way: `captureGlobalErrors` installs no signal handler, and **a
batched entry does not survive `SIGTERM` without one**. Containers are stopped with
`SIGTERM` on every deploy.

## Write economics, measured

Harness, all under
an ephemeral scratchpad (harness not kept):
`final-matrix.mjs` (the matrix), `stdio-truth.mjs` (sync character, backpressure),
`e2e.mjs` and `decompose.mjs` (the real 0.10.0 build), `exit-child.mjs` with `runexit.sh`
(durability). Commands:

```
for RT in node bun; do
  $RT final-matrix.mjs devnull final.jsonl > /dev/null
  $RT final-matrix.mjs pipe    final.jsonl | cat > /dev/null
  $RT final-matrix.mjs file    final.jsonl > f-$RT.log
  script -q -e -c "$RT final-matrix.mjs tty final.jsonl" /dev/null > /dev/null 2>&1
  $RT e2e.mjs e2e.jsonl > /dev/null   # and decompose.mjs, exit-child via runexit.sh
done
```

A single pass drifted 2x on this box, so every cell is the **median of 5 reps**,
strategies measured round-robin within each rep, 10,000 entries per rep (2,000 for the
TTY), on a 214-byte `jsonFormat`-shaped line. `N` is entries per turn; the four `N`
columns are microseconds per entry at the call site. Entries per second is `1e6 / us`,
so the N=100 column is given and the rest are derivable from any cell.

| runtime | target    | strategy               |   N=1 |  N=10 | N=100 | N=1000 | entries/sec at N=100 | write(2)/entry at N=100 |
| ------- | --------- | ---------------------- | ----: | ----: | ----: | -----: | -------------------: | ----------------------: |
| node    | pipe      | console.log per entry  | 1.901 | 1.844 | 1.626 |  1.992 |              614,925 |                   1.000 |
| node    | pipe      | stdout.write per entry | 1.205 | 1.179 | 1.253 |  1.278 |              798,304 |                   1.000 |
| node    | pipe      | batched stdout.write   | 1.331 | 0.298 | 0.037 |  0.056 |           27,150,157 |                   0.004 |
| node    | pipe      | batched console.log    | 1.720 | 0.268 | 0.067 |  0.053 |           14,945,047 |                   0.005 |
| bun     | pipe      | console.log per entry  | 1.120 | 0.819 | 0.780 |  0.792 |            1,281,631 |                   1.000 |
| bun     | pipe      | stdout.write per entry | 0.817 | 0.640 | 0.804 |  1.039 |            1,243,600 |                   1.000 |
| bun     | pipe      | batched stdout.write   | 0.864 | 0.323 | 0.428 |  0.665 |            2,335,932 |                   0.010 |
| bun     | pipe      | batched console.log    | 0.962 | 0.308 | 0.479 |  0.260 |            2,085,536 |                   0.021 |
| node    | file      | console.log per entry  | 2.977 | 2.959 | 2.674 |  3.026 |              373,967 |                   1.000 |
| node    | file      | stdout.write per entry | 2.255 | 2.393 | 3.045 |  2.392 |              328,457 |                   1.000 |
| node    | file      | batched stdout.write   | 2.161 | 0.905 | 0.446 |  0.650 |            2,243,264 |                   0.010 |
| node    | file      | batched console.log    | 2.684 | 0.594 | 0.559 |  0.637 |            1,789,883 |                   0.010 |
| bun     | file      | console.log per entry  | 1.835 | 1.698 | 1.553 |  1.673 |              643,808 |                   1.000 |
| bun     | file      | stdout.write per entry | 1.810 | 1.497 | 1.627 |  1.953 |              614,623 |                   1.000 |
| bun     | file      | batched stdout.write   | 1.735 | 0.623 | 0.446 |  0.504 |            2,242,035 |                   0.010 |
| bun     | file      | batched console.log    | 1.815 | 0.467 | 0.408 |  0.389 |            2,449,247 |                   0.020 |
| node    | tty       | console.log per entry  | 6.655 | 6.080 | 6.391 |  6.541 |              156,461 |                   1.000 |
| node    | tty       | stdout.write per entry | 5.531 | 5.105 | 5.261 |  4.258 |              190,081 |                   1.000 |
| node    | tty       | batched stdout.write   | 5.303 | 4.739 | 4.224 |  4.275 |              236,756 |                   0.011 |
| node    | tty       | batched console.log    | 6.676 | 4.623 | 4.715 |  5.119 |              212,076 |                   0.011 |
| bun     | tty       | console.log per entry  | 5.244 | 3.749 | 4.719 |  5.831 |              211,923 |                   1.000 |
| bun     | tty       | stdout.write per entry | 4.181 | 4.900 | 3.860 |  4.167 |              259,083 |                   1.000 |
| bun     | tty       | batched stdout.write   | 3.792 | 4.768 | 5.231 |  4.664 |              191,156 |                   0.010 |
| bun     | tty       | batched console.log    | 4.891 | 5.303 | 4.996 |  4.015 |              200,149 |                   0.020 |
| node    | /dev/null | console.log per entry  | 1.524 | 1.372 | 1.166 |  1.156 |              857,383 |                   1.000 |
| node    | /dev/null | stdout.write per entry | 1.040 | 0.953 | 0.861 |  0.843 |            1,161,228 |                   1.000 |
| node    | /dev/null | batched stdout.write   | 0.929 | 0.327 | 0.235 |  0.385 |            4,263,116 |                   0.010 |
| node    | /dev/null | batched console.log    | 1.353 | 0.309 | 0.216 |  0.379 |            4,637,266 |                   0.010 |
| bun     | /dev/null | console.log per entry  | 0.369 | 0.373 | 0.374 |  0.358 |            2,676,604 |                   1.000 |
| bun     | /dev/null | stdout.write per entry | 0.320 | 0.596 | 0.315 |  0.365 |            3,175,474 |                   1.000 |
| bun     | /dev/null | batched stdout.write   | 0.318 | 0.169 | 0.078 |  0.261 |           12,834,812 |                   0.010 |
| bun     | /dev/null | batched console.log    | 0.379 | 0.136 | 0.084 |  0.104 |           11,919,377 |                   0.020 |

Reading it, with the write removed entirely as the floor (0.004 to 0.041 microseconds
across every runtime and target, so every number above is essentially all write):

- **Batching pays from about N=10 upward and not at N=1**, where there is nothing to
  batch and the schedule is pure overhead.
- **The `pipe` rows under 0.010 syscalls/entry are not a clean win.** Once the reader falls
  behind, libuv coalesces queued chunks with `writev` and the call site pays a queue push,
  not a write. `/dev/null` is the honest syscall-bound figure, for the same reason dunx's
  harness moved its subjects there.
- **A TTY write is dominated by the terminal, not the syscall**, so batching buys 1.4x on
  Node and nothing on Bun (0.9x, inside the noise). Development is the TTY case and where
  `pretty` is used, so the default must stay unbatched.
- **`console.log` against `process.stdout.write`:** on Node `stdout.write` is 1.2x to
  1.6x faster per entry (1.040 against 1.524 to /dev/null); on Bun it is a wash and
  sometimes slower (1.627 against 1.553 to a file). **For the batched flush the two are
  equal** (0.216 against 0.235 on Node, 0.084 against 0.078 on Bun), so the flush goes
  through `console.log`, which keeps `spyOn(console, 'log')` working - `transport.test.ts`
  relies on it at five sites.

### End to end through the real 0.10.0 build

`logger.info('GET /v1/orders/8814 200', fields)` to /dev/null, 100 entries per turn,
median of 5 reps over 20,000 entries, importing `dist/esm/index.js`:

| subject                     | node us/entry | bun us/entry | write(2)/entry |
| --------------------------- | ------------: | -----------: | -------------: |
| 0.10.0 `ConsoleTransport`   |         9.517 |        8.362 |          1.000 |
| prototype batched transport |         9.474 |        8.292 |  0.010 / 0.020 |
| format, no write            |         8.696 |        8.015 |          0.000 |
| no format, no write         |         6.920 |        7.801 |          0.000 |

Direct decomposition (`decompose.mjs`, median of 5 x 50,000) agrees, in node / bun
microseconds: `createLogEntry` 2.206 / 1.875, `sanitizeLogEntry` 3.161 / 4.291,
`jsonFormat` 0.840 / 0.428. The batched prototype is 0.043 microseconds faster on Node and
0.070 on Bun, both inside the noise. **The write is not the cost of an entry here.**

### Scheduling the flush

`setImmediate` round trip is 1.51 to 3.83 microseconds on Node and 1.44 to 3.04 on Bun;
`setTimeout(fn, 0)` is **1.28 to 1.34 milliseconds** on both, since both clamp to at least
1 ms. dunx's `ConsoleLogger` uses `setTimeout(flushPending, 0)`, so its batch window is a
millisecond rather than the event-loop turn its comment claims. `setImmediate` is the
tighter window, exists on both runtimes with a working `.unref()`, and amortized over N
entries costs 0.015 to 0.038 microseconds at N=100.

## What survives which exit

One spawned subprocess per cell, each in its own session via `setsid`, stdout redirected
to a file. Each child writes `EARLY` unbatched, puts `PENDING` in a batch buffer, then
triggers the condition. The cell says whether `PENDING` reached the file.

`throw` and `rejection` install the `captureGlobalErrors` shape: a synchronous flush
inside the handler, then `process.exit`. `SIGTERM +handler` installs a handler that
flushes and exits. `exit-only` installs a handler that **only** calls `process.exit()`,
so the flush has to come from the `exit` hook.

**Node 24.18.0 and Bun 1.3.14 gave identical results in all 92 cells.**

| flush hook              |  normal  | exit(0)  | throw | rejection | SIGTERM | SIGTERM +handler | SIGTERM exit-only | SIGINT | SIGINT exit-only | SIGKILL |
| ----------------------- | :------: | :------: | :---: | :-------: | :-----: | :--------------: | :---------------: | :----: | :--------------: | :-----: |
| `sync` on `exit`        |   YES    |   YES    |  YES  |    YES    |  lost   |       YES        |        YES        |  lost  |       YES        |  lost   |
| `async` on `exit`       | **lost** | **lost** |  YES  |    YES    |  lost   |       YES        |     **lost**      |  lost  |     **lost**     |  lost   |
| `sync` on `beforeExit`  |   YES    |   lost   |  YES  |    YES    |  lost   |       YES        |        n/a        |  lost  |       n/a        |  lost   |
| `async` on `beforeExit` |   YES*   |   lost   |  YES  |    YES    |  lost   |       YES        |        n/a        |  lost  |       n/a        |  lost   |
| none                    |   lost   |   lost   |  YES  |    YES    |  lost   |       YES        |       lost        |  lost  |       lost       |  lost   |

Exit codes observed: 143 SIGTERM, 130 SIGINT, 137 SIGKILL, 1 uncaught throw. `*` the
async `beforeExit` variant flushed and then **hung until the 10 s `timeout` killed it
(exit 124)** on both runtimes: awaiting inside `beforeExit` schedules more work, which
re-arms `beforeExit`.

What this settles:

1. **An async flush on `process.on('exit')` loses the entry on a normal drain and on
   `process.exit()`, on both runtimes.** The types.ts claim is correct and now measured.
2. **`beforeExit` can await** and is still not a substitute: it does not run on
   `process.exit()`, does not run on any signal, and an async handler there can hang the
   process.
3. **A synchronous flush on `process.on('exit')` is the only hook covering both normal
   drain and `process.exit()`.** That is what `FileTransport` already registers when
   `bufferBytes > 0`.
4. **SIGTERM and SIGINT lose a batched entry unless something installs a handler.** Any
   handler suffices; it need not flush, because installing one lets the `exit` hook run.
   `captureGlobalErrors` installs none today.
5. **SIGKILL loses it, always.** Unfixable, and the reason `warn` and above must never be
   batched.

## The Transport contract

**The all-synchronous rule survives on the evidence in row 2 above.** The interface needs
**no change at all**: `FileTransport` already batches behind `write()` plus `flush()`
with `bufferBytes`, which proves the contract already expresses buffering. Restated as it
should remain, with the doc comment upgraded from assertion to measurement:

```ts
/**
 * A sink for sanitized log entries.
 *
 * Every method is synchronous. Measured on Node 24.18 and Bun 1.3.14, an `async`
 * flush on `process.on('exit')` never completes - the entry is lost on a normal
 * drain and on `process.exit()` alike - while a synchronous one survives both.
 * `beforeExit` can await, but does not run on `process.exit()` or on a signal, and
 * an async handler there can stop the process exiting at all.
 *
 * A transport that buffers owes a synchronous `flush()`, registration on
 * `process.on('exit')` (see `ExitFlush`), and no timer that keeps the process
 * alive - `unref()` it.
 */
export interface Transport {
  /** Minimum level this transport writes. Falls back to the logger's own level. */
  readonly level?: LogLevel;
  write(entry: LogEntry, level: LogLevel): void;
  flush?(): void;
  close?(): void;
}
```

Two things are added around it rather than inside it. `ExitFlush` first, because
`FileTransport` and the new buffered transport both need the same registration and one
declaration should own it - a `Set` of synchronous callbacks behind a single
`process.on('exit')` listener, each target's throw swallowed since at exit there is
nowhere left to report it to:

```ts
/** Deduplicated `process.on('exit')` registration for buffering transports. */
export class ExitFlush {
  /** Returns an unregister function, for `close()` to call. */
  static register(flush: () => void): () => void;
}
```

Then the buffered transport's options. `maxBufferBytes` (default 1 MiB) is the bound that
stops this becoming a second unbounded queue on top of the runtime's own; `onFull` is the
backpressure choice argued below.

```ts
export interface BufferedConsoleTransportOptions {
  level?: LogLevel;
  format?: LogFormatter;
  pretty?: boolean;
  /** Flush at this many pending bytes rather than growing. Default 1 MiB. */
  maxBufferBytes?: number;
  /** Also flush a partial buffer this often. Default 0, per turn only. */
  flushIntervalMs?: number;
  /** Synchronous flush on `process.on('exit')`. Default `true`. */
  flushOnExit?: boolean;
  onFull?: 'block' | 'drop';
}
```

`warn`, `error` and `fatal` are never buffered: they go to `console.error` immediately and
flush everything queued ahead of them first, so the entries read after an incident, and
everything leading to them, were never held back. There is no option to disable that.

## Destinations that ship

**`ConsoleTransport` - keep, unchanged.** Switching it to `process.stdout.write` buys
0.36 to 0.70 microseconds on Node out of a 9.5 microsecond call and nothing on Bun, and
breaks `spyOn(console, 'log')` at five sites in `transport.test.ts` plus every consumer
test doing the same. Not worth it.

**`BufferedConsoleTransport` - new, `src/buffered.ts`.** Concatenates `info` and below
into one string and flushes on an `unref`'d `setImmediate` through `console.log`. Who
needs it: any service emitting more than about 10 entries per event-loop turn to a pipe or
a file, which is every request-logging HTTP service. A new file because
`transport.test.ts` is already 426 lines against a 500-line cap, and a separate class
rather than a `buffer: true` flag so `ConsoleTransport` keeps its one-write-per-entry
contract and every existing test and consumer sees no change.

**`FileTransport` - keep, `bufferBytes` default stays 0.** It already does the right
thing: `writeSync` on an append fd, batching when asked, blocking rather than queueing, a
drop counter announced in-band, and an exit hook. Its only edit is moving that hook onto
`ExitFlush`; at 310 lines nothing else goes in the file.

**`StreamTransport` - new, `src/stream.ts`, ~55 lines.** Writes formatted lines to any
`node:stream.Writable`, which is the destination that makes the four refused ones somebody
else's problem: a TCP socket to syslog, a gzip stream, a rotating stream from another
library, a child-process sink and a custom collector are all a `Writable`. It ships stating
that its flush guarantee is **weaker** than `FileTransport`'s, since a socket's `write`
completes asynchronously and no synchronous exit hook can force it. Documented rather than
papered over.

**`MemoryTransport` - keep**, in `./testing`, unchanged. Nothing else ships.

## Destinations refused

**Syslog over UDP or TCP (RFC 5424).** The framing is real work to get right - PRI
arithmetic, octet-counted against newline-delimited transfer, structured-data escaping, the
480/2048-byte length rules - for a destination a consumer reaches in four lines with
`StreamTransport` plus `net.connect`. UDP also loses lines with no signal, the property a
logger must not have by default. `syslog-client` exists.

**HTTP batching transport.** The clearest case of inventing what a mature library solves:
retries, backoff, a circuit breaker, a bounded queue with a spill policy, TLS, auth-token
refresh, and a flush at exit that **cannot be synchronous** - row 2 of the exit matrix says
it would not run. The production answer is that the collector reads stdout: Vector, Fluent
Bit, Promtail and the Docker and Kubernetes log drivers all do this outside the process,
where a crash cannot take the buffer with it.

**OTLP logs.** Refused as a shipped transport. Measured with `bun pm view`:
`@opentelemetry/exporter-logs-otlp-http@0.221.0` is 56.62 KB itself but pulls 3 direct
and 8 transitive packages - `otlp-exporter-base` 0.64 MB, `otlp-transformer` 1.1 MB,
`sdk-logs` 0.68 MB, `api-logs` 136.91 KB, `core` 0.58 MB, `resources` 0.44 MB,
`semantic-conventions` **12.0 MB** - plus `@opentelemetry/api` 1.0 MB as a peer.
**About 16.6 MB unpacked across 9 packages**, still on a `0.x` version out of the repo's
`experimental/` tree. Even as an optional peer that is a large surface to document,
version-pin and test against for a logger whose own `dist` is a few hundred KB. It also
brings a second batching layer, since `BatchLogRecordProcessor` has its own queue and its
own async export, so arkv would buffer into a buffer. A consumer already running an OTel
`LoggerProvider` bridges to it with a ~20-line `Transport` in their own repo, which beats
arkv guessing at their resource attributes. A parallel agent is evaluating OTel for dunx
metrics; that decision concerns metrics and does not change this one.

**Off-thread writing via `worker_threads`.** Priced honestly: it buys moving the
`write(2)` off the loop, at most 0.821 microseconds on Node or 8.6% of the call, and costs
a `postMessage` plus a structured clone of every entry on the hot path (likely more than
the syscall it removes), a second queue that SIGKILL loses on top of the first, a worker
that keeps the process alive unless carefully unref'd, and a flush at exit that is
necessarily async, which row 2 shows does not complete. Worse durability for a fraction of
8.6%.

**An unbounded async console transport.** Already measurable as a defect: it is what Node does to a full pipe, and it queued 7,936,000 bytes in memory in the probe below.

## Backpressure

**What the current code does: nothing, and it has nothing to check.** `ConsoleTransport`
calls `console.log`/`console.error`, which return `undefined`. `FileTransport` is the
opposite and already correct - it loops on `writeSync`'s returned byte count, so it
blocks, and its docstring already says it "blocks rather than queues".

So today the console answer is whatever the runtime does, and the runtimes disagree.
From `stdio-truth.mjs`, 40,000 x 200-byte writes, syscalls read inside the loop and again
after a full drain:

| runtime | target           | us/entry at call site | write(2)/entry | sync at call site | `write()===false` | queued bytes after loop |
| ------- | ---------------- | --------------------: | -------------: | :---------------: | ----------------: | ----------------------: |
| node    | pipe, drained    |                 1.876 |          1.000 |        yes        |                 0 |                       0 |
| node    | **pipe, unread** |             **0.361** |      **0.008** |      **no**       |        **39,353** |           **7,936,000** |
| node    | file             |                 1.699 |          1.000 |        yes        |                 0 |                       0 |
| node    | tty              |                 5.232 |          1.000 |        yes        |                 0 |                       0 |
| bun     | pipe, drained    |                 0.778 |          1.000 |        yes        |                 1 |                       0 |
| bun     | **pipe, unread** |                 1.260 |          1.000 |      **yes**      |            39,680 |                   **0** |
| bun     | file             |                 0.784 |          1.000 |        yes        |                 0 |                       0 |
| bun     | tty              |                 2.887 |          1.000 |        yes        |                 0 |                       0 |

**Node's `process.stdout` is synchronous for a file, a TTY and a pipe with room** - one
`write(2)` per entry, matching its documentation for Linux. On a **full** pipe it stops
being synchronous: after 323 writes it takes EAGAIN, libuv queues, `write()` returns false,
and 7.6 MB accumulates in `writableLength` while the call site gets _faster_. **Bun stays
synchronous and blocks instead**, holding `writableLength` at 0. Same `ConsoleTransport`
source, two failure modes: unbounded memory growth on Node, a stalled loop on Bun.

**What it should do.** The policy belongs in `BufferedConsoleTransport`, the transport
that owns a queue, and the choice is stated as a choice:

- **`maxBufferBytes`, default 1 MiB: flush early rather than grow.** The bound arkv
  controls, guaranteeing it never adds a second unbounded queue on top of Node's.
- **Blocking is the default**, matching `FileTransport`'s existing documented answer so the
  two agree. A logger that silently drops an audit line is the worse defect, and the batch
  is at most `maxBufferBytes`, so a block is bounded.
- **Dropping is opt-in** for a consumer who would rather lose lines than latency, and a drop
  is **counted and announced in-band on the next successful write**, reusing
  `FileTransport`'s `#dropNotice` shape rather than a second one.
- **Growing without bound is not offered.**

What the runtime then does with the flushed write stays the runtime's: arkv cannot make
Node block on a pipe without `setBlocking`, which is not public API. Fewer and larger
writes is the mitigation arkv can deliver, and it is what the matrix measures.

## What I need from the serializer

- **`LogFormatter` keeps returning `string`.** The batched transport concatenates, and a JS
  string concatenation is a rope costing almost nothing; a formatter returning `Uint8Array`
  would force a per-entry encode, the cost batching removes.
- **No trailing newline from a formatter.** `jsonFormat` and `prettyFormat` are already
  correct; the transport adds the separator and concatenation depends on it.
- **Formatters stay synchronous and never throw**, including on a cycle, as `safeStringify`
  already ensures.
- **A fused sanitize-plus-serialize walk must still expose a `string`-returning
  `LogFormatter`**, or the buffered transport needs a second path.
- The 5.4 to 6.2 microseconds of assembly plus sanitization is where the owner's target
  lives, and nothing at the destination end moves it.

## Breaking changes

`Transport` does not change, so the answer for every consumer is the same: nothing breaks.

- **`@arkv/logger` itself.** `ConsoleTransport`, `FileTransport` and `MemoryTransport` keep
  their behaviour, so `transport.test.ts`'s `expect(logSpy).toHaveBeenCalledTimes(1)` at
  lines 176 and 240 keeps passing - it would not if batching were the default, a large part
  of why batching is a separate opt-in class.
- **`@arkv/nestjs-context-logger` 0.3.7.** Depends on `@arkv/logger` as a `dependency` and
  touches the contract at two places, `context-logger.service.ts:181` and `:195`, both
  `this.#logger.flush()` on the `Logger`, not on a `Transport`. It implements no transport.
  Its `onApplicationShutdown` docstring already relies on "the file transport's own
  `process.on('exit')` hook", which the exit matrix confirms and `ExitFlush` preserves.
  Nothing breaks; no change required.
- **`packages/nestjs-cms`.** Named in the brief as a consumer; it is not one.
  `dependencies` is `{}`, its peers are Nest, Swagger, Fastify and `reflect-metadata`, and
  a grep for `@arkv/logger` and `@arkv/nestjs-context-logger` across the package returns
  zero files. Unaffected.
- **dunx `@dunx/infra/logger`.** `packages/infra/src/logger/index.ts` re-exports the
  `Transport` type plus `ConsoleTransport`, `FileTransport`, their option types,
  `RotationInterval`, the formatters, `LogFormatter`, `LoggerConfig`, `ContextStore` and
  `captureGlobalErrors`. Two sites consume the contract:
  `packages/infra/src/logger/module.test.ts:330` builds
  `const transport: Transport = { write, flush, close }` as an object literal, and
  `examples/full/src/app.module.ts:31` builds a `Transport[]` from `ConsoleTransport` plus
  a `FileTransport` already setting `bufferBytes: 16 * 1024`. **A new required interface
  member would break that object literal; nothing here adds one.** Exposing the new
  transports is four additive lines in that re-export list. Doing nothing also works.
- **`captureGlobalErrors`.** Gains an opt-in `signals?: boolean | NodeJS.Signals[]`,
  default **off**, because installing a SIGTERM handler changes process behaviour and must
  not happen silently. Additive.

**Verdict: minor. `@arkv/logger` 0.11.0.** Nothing removed or narrowed, no required member added to any interface.

## Cost

| file                         |    ~LOC | note                                                   |
| ---------------------------- | ------: | ------------------------------------------------------ |
| `src/buffered.ts`            |     110 | `BufferedConsoleTransport`                             |
| `src/buffered.test.ts`       |     180 | new file: `transport.test.ts` is at 426 of 500         |
| `src/stream.ts` + `.test.ts` | 55 + 90 | `StreamTransport` over `node:stream.Writable`          |
| `src/exit.ts` + `.test.ts`   | 45 + 60 | `ExitFlush`, shared with `FileTransport`               |
| `src/errors.ts`              |     +25 | opt-in signal handlers (edit)                          |
| `src/file.ts`                |      -8 | exit hook moves to `ExitFlush` (edit, stays under 310) |
| `src/index.ts`               |      +5 | exports (edit)                                         |
| `src/types.ts`               |      +0 | doc comment only (edit)                                |

About 570 new lines across 6 new files, each well under the 500-line cap.
**New dependencies: none. New optional peers: none.** `node:stream` is a built-in and
`file.ts` already imports `node:fs` and `node:path`. No `Bun.*` API, no top-level `await`,
no `import.meta`, so the CJS build is unaffected. `setImmediate`, `clearImmediate` and the
handle's `.unref()` were verified on both Node 24.18 and Bun 1.3.14, with a
`setTimeout(fn, 0)` fallback if the global is absent.

**Measured gain.** On the write path at 100 entries per turn: 5.4x on Node and 4.5x on
Bun to /dev/null, 4.8x and 3.8x to a file, 1.4x and 0.9x to a TTY. `write(2)` per entry
falls from 1.000 to 0.010. **End to end through `Logger` today: 1.00x**, because the
write is 8.6% of a 9.517 microsecond call on Node and 4.2% of 8.362 on Bun. The batched
transport becomes worth its 4.5x once the sanitizer work lands and an entry stops costing
6 to 8 microseconds.

**To republish:** `@arkv/logger` 0.11.0 only. `@arkv/nestjs-context-logger` picks it up
through `workspace:^` on its next release with no code change; `@dunx/infra` needs a patch
release only if it wants to re-export the new transports, and compiles unchanged either
way.
