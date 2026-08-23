# @arkv/logger: entry assembly, redaction, and the bytes

Scope: everything between `Logger#writeLog` being called and a string existing - `src/entry.ts`,
`src/sanitize.ts`, `src/format.ts`, `safeStringify` from `@arkv/shared`. Transports, batching and
backpressure belong to the sibling report at `internal/notes/research/arkv-logger-transports.md`. Measured on
branch `feat/abstract-log-context` (tip `88b8ae6`), Bun 1.3.14 and Node v24.18.0, 20-core WSL2.
`cd packages/logger && bun test` is **179 pass, 0 fail, 404 expects, 12 files, 160 ms** there.

## Verdict

**Fuse the two walks into one, cache the result per encoding, and ship three encodings: `ndjson`,
`pretty`, `logfmt`. A log call goes from 6.864 us to 2.222 us on Bun (3.09x) and from 5.557 to
3.290 on Node (1.69x) for a message plus five fields, with 44 of 44 corpus payloads
byte-identical.** Minor release, 0.11.0.

The owner's two asks are one mechanism: a walk that redacts while it emits does the work once,
allocates no intermediate object, and is parameterised by the encoding it emits.

Four things beyond the fusion, in the order they are worth taking:

- **Memoize the mask decision per key.** Not in the brief and larger than three of the five
  hypotheses together. `shouldMask` lowercases the key and all eight mask fields for every key of
  every entry, 4.123 us for a 20-key entry on Bun; a bounded `Map<string, boolean>` takes that to
  0.091 us, **45x**, byte-identical by construction.
- **Guard `searchForError` against binary, `Date` and `RegExp`.** `findNestedError` enumerates a
  `Uint8Array(65536)` index by index: **17,949 us on Bun, 4,129 on Node, per log call**. One
  `ArrayBuffer.isView` check makes it 0.057 us. A defect, not a cost.
- **Cache the timestamp on `Date.now()` at millisecond resolution.** 0.593 us to 0.047 on Node, 10.4%
  of a log call, emitted string unchanged, so not the breaking trade the brief priced.
- **Do not fuse without the per-encoding cache.** Three transports fused and uncached is a net **loss**
  on 8 of 13 payloads on Node, down to 0.60x; cached it is 1.44x to 2.68x.

Refused: MessagePack and CBOR, an OpenTelemetry-shaped JSON, and adopting or wrapping pino.

## Baseline, measured

Harness `scratchpad/arkv-logger/{timer,corpus,baseline}.mjs`, plain `.mjs` so both runtimes run
byte-identical code, importing `packages/logger/dist/esm` (current with the branch: it has
`readContextOnce` and no `#shouldLog`). Run as `bun baseline.mjs > rerun-bun.md` and
`node baseline.mjs > rerun-node.md`; both files are verbatim and carry a 3-transport column omitted
below. Microseconds per entry, whole-loop timing, 7 reps, minimum kept, warmed 25%. `med` and `p99` are
per-iteration samples through `Logger#info` with one transport whose `write` calls `jsonFormat` and
discards the string, so no syscall is inside any figure; `performance.now()` overhead was 45.4 ns on
Bun, 37.9 on Node. **I re-measured every number in this report**: the dead run's tables survive at
`out-bun.md` and `out-node.md`, mine are 15 to 25 percent lower on Bun (flat-5 end to end 7.771
against its 9.629) and agree within noise on Node, and the only figure taken from the sibling rather
than re-derived is the write's 4 to 9 percent share of a log call.

| payload          | out B | bun find  | bun create | bun san | bun str | bun e2e   | bun med   | bun p99   | node find | node create | node san | node str | node e2e | node med | node p99  |
| ---------------- | ----- | --------- | ---------- | ------- | ------- | --------- | --------- | --------- | --------- | ----------- | -------- | -------- | -------- | -------- | --------- |
| bare-string      | 171   | -         | 1.184      | 2.278   | 0.207   | 4.231     | 3.439     | 18.363    | -         | 1.167       | 1.270    | 0.382    | 3.634    | 2.944    | 7.451     |
| flat-5           | 219   | 0.142     | 1.362      | 3.452   | 0.297   | 7.771     | 10.627    | 56.495    | 0.141     | 1.108       | 1.807    | 0.493    | 5.237    | 5.378    | 14.910    |
| flat-20          | 422   | 0.536     | 2.655      | 9.450   | 0.540   | 15.689    | 12.415    | 42.353    | 0.777     | 5.407       | 6.442    | 2.026    | 18.005   | 16.513   | 47.268    |
| nested-4         | 243   | 0.452     | 1.378      | 5.426   | 0.307   | 9.549     | 7.502     | 31.300    | 0.397     | 1.074       | 3.892    | 0.685    | 6.990    | 7.066    | 18.010    |
| masked-field     | 235   | 0.223     | 1.294      | 3.136   | 0.220   | 7.243     | 6.432     | 30.904    | 0.138     | 1.152       | 2.104    | 0.613    | 6.132    | 5.340    | 10.969    |
| error-with-stack | 175   | -         | 1.294      | 2.467   | 0.239   | 7.097     | 5.430     | 24.296    | -         | 1.188       | 1.292    | 0.359    | 5.694    | 6.593    | 19.755    |
| map-and-set      | 263   | 0.189     | 1.293      | 4.051   | 0.389   | 7.089     | 6.165     | 27.059    | 0.150     | 1.263       | 2.760    | 0.840    | 6.363    | 5.129    | 15.872    |
| array-200        | 492   | 0.923     | 1.158      | 3.409   | 1.062   | 10.352    | 9.216     | 32.030    | 0.911     | 1.008       | 2.227    | 1.340    | 7.531    | 7.015    | 18.480    |
| typed-array-64k  | 198   | 18247.596 | 1.192      | 2.786   | 0.226   | 17635.994 | 20277.092 | 32268.762 | 3690.418  | 1.120       | 2.394    | 0.661    | 4000.327 | 3875.208 | 10511.983 |
| circular         | 265   | 0.134     | 1.566      | 3.944   | 0.283   | 8.762     | 7.223     | 32.425    | 0.134     | 1.274       | 2.706    | 0.664    | 5.658    | 5.109    | 14.819    |
| throwing-getter  | 205   | 1.665     | 1.272      | 4.704   | 0.251   | 10.564    | 8.371     | 40.065    | 5.548     | 1.221       | 9.060    | 0.576    | 18.748   | 19.699   | 56.830    |
| shared-ref-twice | 226   | 0.293     | 1.418      | 4.495   | 0.341   | 8.472     | 6.973     | 31.099    | 0.150     | 1.085       | 2.827    | 0.578    | 6.087    | 6.689    | 18.217    |
| deep-chain-1000  | 740   | 3.920     | 1.128      | 21.160  | 1.176   | 33.293    | 27.594    | 86.079    | 3.118     | 0.995       | 21.409   | 2.898    | 32.862   | 32.673   | 77.717    |

`find` is `findNestedError`, `create` is `createLogEntry`, `san` is `sanitizeLogEntry`, `str` is
`safeStringify`. The reference payload throughout is **flat-5**, a message plus five flat fields,
which is what a request log line is: **7.771 us on Bun, 5.237 on Node**, of which the three stages
this report owns are **5.111 (66%)** and **3.408 (65%)**. flat-5's `med` above its `e2e` on Bun is
the per-iteration timer's floor, not a slower path. Two payloads are defects rather than costs -
`typed-array-64k` at **17.6 ms** on Bun and **4.0 ms** on Node, and `throwing-getter` - and
`findNestedError` is all of the first and half of the second.

## Where the time goes

Harness `micro2.mjs`, mine, written for this pass: fixed iteration counts, 25% warmup, 7 reps, minimum
kept, because `timer.mjs`'s wall-clock calibration gave the cheap operations only ~90k iterations off
an unwarmed probe. Output in `micro2-bun.md`, `micro2-node.md`.

| operation                                                     | Bun                       | Node                     |
| ------------------------------------------------------------- | ------------------------- | ------------------------ |
| `new Set(RESERVED_ENTRY_KEYS)` + 2 deletes / 6 frozen lookups | 0.6434 / 0.0026           | 0.2455 / 0.0042          |
| `LOG_LEVELS.indexOf` x2 / frozen map x4                       | 0.0196 / 0.0032           | 0.0113 / 0.0033          |
| `new Date().toISOString()` / `Date.now()` / ms-cached ISO     | 0.1405 / 0.0309 / 0.0293  | 0.5930 / 0.0484 / 0.0473 |
| `shouldMask` 1 / 5 / 20 keys, as shipped                      | 0.1821 / 0.9548 / 4.1233  | 0.1281 / 0.5737 / 2.8709 |
| `shouldMask` 20 keys, lowercase precomputed / memoized        | 1.7677 / 0.0911           | 1.5112 / 0.2097          |
| `WeakSet` / `Set` add+has+delete x8 (keep `WeakSet`)          | 0.4017 / 0.2608           | 0.3737 / 0.4468          |
| `JSON.stringify` clean / cyclic throw+recover                 | 0.0970 / 1258.8           | 0.2363 / 4.0735          |
| `findNestedError` 64KB / guarded / 64-**byte**                | 16792.4 / 0.0638 / 7.4935 | 3898.0 / 0.0555 / 1.6011 |

**H1, two full walks per entry: CONFIRMED.** On a pre-built entry, one fused walk against
`sanitizeLogEntry` then `safeStringify`: flat-5 3.994 to 1.952 us on Bun (**2.05x**) and 2.678 to
1.809 on Node (**1.48x**); flat-20 9.173 to 4.170 and 8.895 to 4.379. Fusing entry assembly in too,
the whole `Logger#info` call goes 6.864 to 2.222 us on Bun (**3.09x**, 4.64 saved) and 5.557 to 3.290
on Node (**1.69x**, 2.27 saved), 44 of 44 corpus payloads byte-identical and 15 of 16 end to end, the
miss being one branch the prototype omits (`extra.context` for a string param at info level).

**H2, the fusion costs with multiple transports: CONFIRMED, and worse than a wash.** Three transports
on one encoding, fused, uncached: Bun flat-20 14.578 to 14.749 (0.99x) and array-200 13.590 to 17.105
(**0.79x**); Node loses on 8 of 13 payloads, down to 0.60x on `error-with-stack`. Cached: Bun 2.07x to
2.69x, Node 1.44x to 2.68x. The cache is a requirement of the claim.

**H3, `levelIndex` is an O(n) string scan: REFUTED as a win.** Two calls per entry with one transport
cost 0.0196 us on Bun and 0.0113 on Node against 0.0032 and 0.0033 for a frozen numeric map over
four. The saving is 0.016 us, **0.2% of a log call**. Take it because it is one line.

**H4, `new Set(RESERVED_ENTRY_KEYS)` per call: CONFIRMED on Bun, marginal on Node.** With the two
`delete` calls that follow, 0.6434 us on Bun and 0.2455 on Node against 0.0026 and 0.0042 for six
frozen-object lookups: **8.3% of a Bun log call**, 4.7% of a Node one. The fused path removes it.

**H5, `new Date().toISOString()` per entry: CONFIRMED, and it need not break the output.** 0.1405
us on Bun, **0.5930 on Node**, 11.3% of a Node log call. Second-resolution caching is breaking as
the brief says, and unnecessary: `new Date(Date.now()).toISOString()` is the same string as
`new Date().toISOString()`, so a cache keyed on the **millisecond** emits identical bytes at 0.0293
/ 0.0473 us, saving 0.112 on Bun and 0.546 on Node. At 2 to 7 us per entry tens of entries share a
millisecond under load, so the hit rate is high exactly when it matters, and a quiet logger pays one
extra `Date.now()`. Second-resolution caching measures no faster (0.0366 / 0.0551) and does change
the output. **Take the millisecond cache, drop the other, and there is no timestamp break to
price.**

**The cyclic-stringify datum: verified, and the published 87x does not reproduce.**
`JSON.stringify` on a cyclic object costs **1258.8 us on Bun** and **4.07 us on Node** to throw,
against 0.097 and 0.236 clean: 12,977x and 17x. A whole circular entry costs 4.227 us on Bun today,
so the sanitizer's cycle handling is **298x** cheaper than throw-and-recover there and break-even
on Node. The reason to keep it is the output either way: `safeStringify`'s fallback renders a bare
`"[Circular]"` where the sanitizer renders `{"[Circular]":"circular reference detected"}` with the
surrounding fields intact.

**Not in the brief, and the largest ordinary cost: `shouldMask`.** It runs once per key at every
depth and lowercases the key **and all eight mask fields** each time. A flat-5 entry carries 12
top-level keys, so masking is roughly 2.2 of the 3.452 us Bun spends in `sanitizeLogEntry` and 4.1
of 9.45 for flat-20. Precomputing the lowered list is 2.3x/1.9x; memoizing per key string is **45x
on Bun, 14x on Node**. Log keys come from a small fixed set of call sites, so the cache saturates
within a few entries: the probe ends with 25 in it.

**Not in the brief, and a defect: `findNestedError` walks binary payloads element by element.**
`searchForError` treats anything `typeof 'object'` that is not `Array.isArray` as a record and calls
`safeEntries` on it, so a `Uint8Array(65536)` becomes a 65,536-entry array of `[index, byte]` pairs
it recurses into: **17,949 us per log call on Bun, 4,129 on Node**, searching for an `Error` inside
bytes where one cannot be, and a 64-byte typed array still costs 7.49 / 1.60. With a guard rejecting
`ArrayBuffer.isView`, `ArrayBuffer`, `Date` and `RegExp`: 0.057 us, **314,765x on Bun, 71,233x on
Node**. The sanitizer renders those by description, so nothing reachable through them was ever in
the output.

**`throwing-getter` is the payload the fusion barely helps** - 9.968 to 5.498 us on Bun, 21.789 to
19.973 on Node - because the getter throws in `findNestedError` and again in the walk. Leave it.

**String building: concatenate, do not `join`** (0.5514 against 2.2008 us on Bun, 1.0029 against
1.6908 on Node). The honest counterpoint: `JSON.stringify` of the same 20 fields is 0.3608 us on Bun,
so a hand-rolled encoder **loses to native serialization by 1.53x on the emit step**. The fusion wins
by deleting the deep copy and the mask work, not by out-serializing the engine.

## The fused serializer

`src/encode.ts`, one walker parameterised by a table of the operations an encoding differs in. The walk
mirrors `makeSafeForJson`'s check order exactly - `Date`, `RegExp`, `Error`, `FormData`, file-like,
`Blob`, `ArrayBuffer`, `ArrayBuffer.isView`, visited, depth, then array / `Map` / `Set` / record -
emitting instead of copying. `LogEncoding` is a frozen object plus an indexed-access companion type
like `LogLevel`; `EncodingOps` is what an encoding decides - `objOpen`, `objClose`, `sep`, and `key`,
`str`, `num` - and values below the top frame always use JSON.

```ts
export class EntryEncoder {
  #masked(key: string): boolean {
    const cached = this.#maskCache.get(key);
    if (cached !== undefined) return cached;
    const lower = key.toLowerCase();
    let found = false;
    for (let index = 0; index < this.#masks.length; index += 1) {
      if (lower.includes(this.#masks[index])) {
        found = true;
        break;
      }
    }
    if (this.#maskCache.size < MASK_CACHE_MAX) this.#maskCache.set(key, found);
    return found;
  }

  encode(parts: EntryParts): string {
    const ops = this.#ops;
    const { level, timestamp, message, appId, error } = parts;
    // Not seeded with the merged object: `sanitizeLogEntry` seeds a freshly built entry no
    // caller field can reference, so seeding a **borrowed** source here would report a
    // self-reference one level shallower.
    const seen = new WeakSet<object>();
    let out =
      ops.objOpen +
      this.#field('level', level, seen, 1) +
      ops.sep +
      this.#field('timestamp', timestamp, seen, 1) +
      ops.sep +
      this.#field('pid', PID, seen, 1) +
      ops.sep +
      this.#field('message', message, seen, 1);
    if (appId) out += ops.sep + this.#field('appId', appId, seen, 1);

    const merged = mergeSources(parts);
    let conflicted = false;
    if (merged !== undefined) {
      for (const key of Object.keys(merged)) {
        if (
          isReserved(key) &&
          (key !== 'appId' || appId) &&
          (key !== 'error' || error)
        ) {
          conflicted = true;
          continue;
        }
        let value: unknown;
        try {
          value = merged[key];
        } catch {
          value = '[Getter: threw]';
        }
        if (value === undefined) continue;
        out += ops.sep + this.#field(key, value, seen, 1);
      }
    }

    if (error) out += ops.sep + ops.key('error') + this.#error(error, seen);
    if (conflicted && merged !== undefined) {
      const conflicts = collectConflicts(merged, appId, error);
      if (conflicts !== undefined) {
        out +=
          ops.sep +
          ops.key(RESERVED_CONFLICTS_KEY) +
          this.#value(conflicts, seen, 1);
      }
    }
    return out + ops.objClose;
  }
}
```

The constructor lowercases `maskFields` once, and past `MASK_CACHE_MAX` the predicate still runs so
the answer is never wrong. `#field(key, value, seen, depth)` is
`ops.key(key) + (masked ? ops.str(MASKED) : this.#value(...))`, with `null` returned before the mask
check; `#error` emits `name`, `message` and `stack` through it. `mergeSources` returns the single non-empty source **by reference** when only one of
`bindings`, `context`, `extra`, `invalidMessageInfo` has keys and a four-way spread otherwise, since
multi-source key order is the spread's; that deletes both of `createLogEntry`'s copies and its
`new Set`.

Four equivalence traps found by reading `entry.ts` against the prototype, each a silent output change:

- **`conflicts` key order follows `RESERVED_ENTRY_KEYS`, not the merged object**, since
  `createLogEntry` builds it with `for (const key of reserved)`. Hence the flag.
- **`appId` and `error` are conditionally reserved**, which is what the two `reserved.delete` calls
  mean: `logger.info('x', { appId: 'mine' })` on a logger with no `name` keeps `appId` as an
  ordinary field at its merged position today.
- **The reserved fields still go through `#masked`**: `maskFields: ['message']` masks the message
  today, and memoized the six checks cost 0.006 us.
- **`{ password: null }` emits `null`, not `[MASKED]`**, because `sanitizeObject` returns before
  consulting `shouldMask`.

**The multi-transport answer: one string per encoding per entry, computed on first demand.**

```ts
let cachedName: LogEncoding | undefined;
let cachedText = '';
let extra: Map<LogEncoding, string> | undefined;
let sanitized: LogEntry | undefined;

for (const transport of this.#transports) {
  if (idx < this.#levelOf(transport)) continue;
  const encoding = transport.encoding;
  if (encoding === undefined || transport.writeEncoded === undefined) {
    // A custom `LogFormatter` needs the object, so it and only it pays for the copy.
    sanitized ??= sanitizeLogEntry(
      createLogEntry(parts),
      this.#sanitizeOptions,
    );
    this.#guard(transport, () => transport.write(sanitized as LogEntry, level));
    continue;
  }
  let text = encoding === cachedName ? cachedText : extra?.get(encoding);
  if (text === undefined) {
    text = this.#encoderFor(encoding).encode(parts);
    if (cachedName === undefined) {
      cachedName = encoding;
      cachedText = text;
    } else {
      (extra ??= new Map()).set(encoding, text);
    }
  }
  this.#guard(transport, () => transport.writeEncoded?.(text as string, level));
}
```

One local pair covers the overwhelming case - one transport, or several on one encoding - and
allocates nothing; a `Map` appears only for a second encoding, the console-pretty plus file-JSON
setup. `pretty` is a scan over `ndjson`, not a fourth walk: its encoder hands the string to the
existing `formatColoredJson`, and `#encoderFor(PRETTY)` takes the cached text when there is one.

## Output encodings that ship

Three, measured on the flat-20 entry (411 bytes of NDJSON) in `fused-bench.mjs`:

| encoding             | Bun us | Node us | bytes | who consumes it                  | dependency |
| -------------------- | ------ | ------- | ----- | -------------------------------- | ---------- |
| NDJSON, shipped path | 9.431  | 8.523   | 411   | every log shipper                | none       |
| `ndjson`, fused      | 4.333  | 4.518   | 411   | the same, unchanged bytes        | none       |
| `logfmt`, fused      | 4.140  | 3.503   | 325   | Grafana Loki, Heroku, Go tooling | none       |

**`ndjson` already exists as `jsonFormat`** and stays the default and the byte definition of correct:
not a new encoding, the same one in half the time. **`pretty` already exists as `prettyFormat`** and
joins the enum only so the logger can route it (`pretty` has no row above because it is `ndjson` plus
the existing colour scan). **`logfmt` is the one addition**, 79% of the bytes at the same speed or
faster, and it is what the brief calls a flattened key-value form: scalars as `key=value`, a value
containing a space, quote or `=` quoted through `JSON.stringify`, and any object, `Map` or `Set`
emitted as its JSON, which is what Go's encoders do with a struct. One ops table and a top-frame
choice, ~30 lines. Loki ingests it and parses the fields with no pipeline stage; that is the
consumer, and why this one earns a place a fourth does not.

**MessagePack and CBOR: refused, with the numbers.** `@msgpack/msgpack` 3.1.3 is 0.66 MB unpacked
with **zero dependencies** and ships ESM and CJS, so it would survive arkv's build. It is still the
wrong trade: on the three real entry shapes (`pino-lab/binary.mjs`) msgpack is **0.75 to 0.81x the
bytes and 3.29 to 6.95x the encode time** of `JSON.stringify`, 1.3154 against 0.2084 us for a
five-field entry on Bun. Paying 6x the CPU to save a quarter of the bytes inverts the requirement.
`cbor-x` 1.6.5 is worse on every axis: 1.86 MB and an **optional native dependency**
(`cbor-extract`), a compiled artifact in a package whose appeal to dunx is near-zero transitive
weight. Neither travels through `Transport` as it stands, since `write` and `LogFormatter` produce
`string`.

**An OpenTelemetry-shaped JSON: refused for now.** The mapping is cheap - `Timestamp`,
`SeverityText`, `SeverityNumber`, `Body`, `Attributes` - but nothing consumes an OTel-shaped _file_:
collectors want OTLP over gRPC or protobuf HTTP with resource attributes and batching, an exporter
and therefore a transport.

## The equivalence gate

**A rewrite of this path without a byte-comparison gate is not shippable.** Two of the four traps
above - the `conflicts` key order and the conditional reservation of `appId` - pass a key-set or
`toEqual` comparison and still change what a pipeline receives; the prototype ran 44 of 44 cases
identical and had both, because none built a logger without a `name`.

**Fixtures: `src/fixtures/golden.json`, an array of `{ name, encoding, output }`.** Committed, so its
diff in a pull request is the record of an intended output change. Written by `scripts/gen-golden.ts`
(`bun run gen:golden`) through the **object path**, which is the definition of correct;
`src/golden.test.ts` asserts the encoder's string is `toBe` the fixture. A silent regeneration fails
review, not the test.

**Corpus, about 70 cases,** assembled rather than invented: the 13 payloads in `corpus.mjs` (the
brief's eleven plus a shared reference and a 1000-deep chain), the 31 edge cases in `fused-bench.mjs`
(lone surrogate, `toJSON`, integer-like keys, null prototype, sparse array, `-0`, `1e21`, `NaN`,
`AggregateError`, `WeakMap`, `Promise`, `URL`, `FormData` with a `File`, non-string `Map` keys, mask
casing, array over `maxArrayLength`, depth boundary), every shape `sanitize.test.ts` and
`sanitize-structure.test.ts` pin, and the four the prototype proves are needed: no `appId` with a
caller-supplied one, `level` and `pid` together, `maskFields: ['message']`, `{ password: null }`.

| difference             | permitted | reason                                                                                      |
| ---------------------- | --------- | ------------------------------------------------------------------------------------------- |
| `timestamp` value      | yes       | generated per entry. Both sides replace it with `"T"`; its **position** is asserted.        |
| `pid` value            | yes       | per process. Replaced with `0`.                                                             |
| stack frame paths      | yes       | paths and line numbers move with the checkout. Everything after the stack's first `,` goes. |
| key order              | **no**    | the only cheap total assertion, and two of three real hazards are ordering.                 |
| whitespace             | **no**    | neither side emits any; a difference means a token was emitted wrong.                       |
| ANSI escapes, `pretty` | **no**    | asserted twice: `strip()`ped against the `ndjson` fixture, and raw, so colour changes show. |

**Two assertions beyond the bytes.** `JSON.parse(encoded)` deep-equals
`sanitizeLogEntry(createLogEntry(parts))` for every JSON case, localizing a structural break; and a
three-transport case asserts all three got the **identical string value** and that a walk counter
advanced **once**, so the cache cannot regress into the 0.60x shape. The existing 179 tests stay
untouched: `sanitizeLogEntry` keeps its signature and export, `MemoryTransport` stays object-based,
and `transport.test.ts`'s five `spyOn(console, 'log')` sites see the same strings.

## pino

**Adopt the techniques, do not wrap it, stay independent.** Re-measured by me in `pino-lab` (`bun
bench.mjs`, `node bench.mjs`, output `repino-bun.txt`, `repino-node.txt`; 20k warmup, 100k
iterations, 7 reps, minimum kept, both sinks discarding), `@arkv/logger` 0.10.0 is **4.55x** pino
10.3.1 with redaction on for a message plus five fields on Bun - 5.4639 us against 1.2003 - and
**2.50x** on Node, 4.8550 against 1.9444, with a 3.32x-to-9.34x and 2.29x-to-5.37x spread across
five payloads. Applying the fusion's measured 3.09x/1.69x puts arkv at roughly 1.77 us on Bun and
2.87 on Node, **1.47x and 1.48x pino-with-redaction**, for zero new dependencies. Wrapping pino buys
the remaining ~0.5 us and costs **11 direct dependencies, 12 packages, 2.6 MB installed** (`bun pm
view pino`: 0.66 MB unpacked; `sonic-boom`, `thread-stream`, `@pinojs/redact`,
`safe-stable-stringify`, `pino-abstract-transport` and six more) against `@arkv/logger`'s two, both
first-party, and near-zero transitive weight is the property that lets dunx take it as a
`dependency` rather than an optional peer. It also would not deliver the same output: pino's
`redact` is path-based, so a `password` at an unknown depth needs a wildcard the caller writes, and
`safe-stable-stringify`, which pino serializes through, renders `{ m: new Map([['a',1]]) }` as
`{"m":{}}`, a `Set` as `{}`, a `Uint8Array(4)` as `{"0":0,"1":0,"2":0,"3":0}`, and **throws outright
on a throwing getter** - all four probed here, not assumed. `ContextSource`, the
`RESERVED_ENTRY_KEYS` conflict handling and `@arkv/nestjs-context-logger` would have to be rebuilt
over it regardless. The honest half is the floor rather than the gap: pino without redaction is
0.4042 us against a bare `JSON.stringify`'s 0.2590 on Bun, within 1.6x of the engine, where the
fused arkv would be about 7x it. That is what rendering `Map`, `Set`, cycles, binary and throwing
getters costs.

## What I need from Transport

Two optional members, and nothing about batching, buffers, destinations or backpressure: a
`readonly encoding?: LogEncoding` naming the encoding this transport wants produced for it, and a
`writeEncoded?(text: string, level: LogLevel): void` present with `encoding` or not at all. `write`,
`flush`, `close` and `level` are unchanged.

`ConsoleTransport`, `FileTransport` and `StreamTransport` each set `encoding` when the consumer
supplied **no** `format`, and when the supplied one is `jsonFormat` or `prettyFormat` by identity -
two lines, covering `Logger`'s own default, which constructs
`new ConsoleTransport({ format: isDevelopment ? prettyFormat : jsonFormat })` today and should pass
`{ pretty: isDevelopment }` instead. A transport with a custom `LogFormatter` keeps `encoding`
undefined and receives the sanitized object exactly as today, which is why the object path stays;
`MemoryTransport` stays object-based so a test asserts an entry instead of parsing a line. The
sibling's `bufferBytes`, `flushIntervalMs` and `flushOnExit` are orthogonal.

## Breaking changes

**Minor, 0.11.0.** Every observable difference:

| change                                                                        | observable how                                                     | verdict          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------- |
| the emitted bytes                                                             | nothing. Byte-identical, gate-enforced, ~70 cases, 3 encodings.    | not a change     |
| `Transport` gains `encoding`, `writeEncoded`, both optional                   | an existing implementation compiles and still gets `write(entry)`. | additive         |
| a **subclass** of a built-in transport overriding `write`                     | `write` stops being called for entries on the fused path.          | the one break    |
| `LogEncoding`, `EntryEncoder`, `EncodingOps` exported                         | new names only.                                                    | additive         |
| `LogFormatter`, `jsonFormat`, `prettyFormat`, `sanitizeLogEntry`, `Transport` | unchanged signatures and behaviour, all still exported.            | none             |
| `findNestedError` skips `Date`, `RegExp`, `ArrayBuffer`, typed arrays         | an `Error` attached to one of those is no longer surfaced.         | behaviour change |
| `EntryParts` gains `timestamp`; `Logger`'s default transport construction     | `entry.ts` was never reachable; same output, same class.           | internal         |

**The subclass break.** `ConsoleTransport#write` is public, so a subclass overriding it works today
and stops being consulted once the base declares an `encoding`. The README documents _implementing_
the three-method interface, not subclassing a built-in, and nothing in arkv or dunx does it; the
escape is one line and it goes in the changelog. It is why this is 0.11.0 and not a patch.

**The `findNestedError` guard.** `logger.info({ buffer: Object.assign(new Uint8Array(4), { cause: err
}) })` stops reporting `err`'s stack, but the sanitizer renders that value as `[Uint8Array: 4 bytes]`
either way, so only the top-level `error` key changes. Against 17,949 us, take the guard.

**Affected consumers.** `@arkv/nestjs-context-logger` (`@arkv/logger` as a `dependency`,
`workspace:^`) uses `Logger` and `ContextStore`, no transports and no formatters: nothing to change.
dunx's `@dunx/infra/logger` re-exports `ConsoleTransport`, `ConsoleTransportOptions`,
`FileTransport`, `jsonFormat`, `prettyFormat`, `LogFormatter` and `Transport` verbatim and binds
arkv's `Logger` to `@dunx/core`'s contract with no adapter; all seven keep working, its
`MemoryTransport` tests are on the object path, and it would want `LogEncoding` added to that list
plus a version bump in `packages/infra/package.json`. `packages/nestjs-cms` does **not** depend on
`@arkv/logger` - its `dependencies` is `{}` - which the first run's sibling reported and I confirmed
from the manifest. If the sibling's transports change lands first this is 0.12.0.

## Cost

Files, rough LOC, nothing near the 500-line cap: `src/encode.ts` new ~260; `src/types.ts` +18
(`LogEncoding`, two `Transport` members); `src/logger.ts` +40 -25 (encoder construction, the cache
loop, the timestamp cache, the level map); `src/sanitize.ts` +16 -4 (mask memo, binary guard);
`src/entry.ts` +3 -1 (accept `timestamp`); `src/transport.ts`, `src/file.ts`, `src/stream.ts` +8
each; `src/index.ts` +4; `src/encode.test.ts` new ~260; `src/golden.test.ts` new ~120;
`src/fixtures/golden.json` generated ~80 KB; `scripts/gen-golden.ts` new ~90; `README.md` ~40. **No
new dependencies**, no `Bun.*` API, no top-level `await`, no `import.meta`, so the CJS build holds.

Measured speedup, one transport, whole `Logger#info` call, both columns from one process
(`e2e-bench.mjs`) so the ratio is not exposed to drift:

| payload          | Bun before | Bun after | ratio | saved us | Node before | Node after | ratio | saved us |
| ---------------- | ---------- | --------- | ----- | -------- | ----------- | ---------- | ----- | -------- |
| bare-string      | 4.962      | 1.143     | 4.34x | 3.82     | 3.881       | 1.939      | 2.00x | 1.94     |
| **flat-5**       | 6.864      | 2.222     | 3.09x | 4.64     | 5.557       | 3.290      | 1.69x | 2.27     |
| flat-20          | 13.383     | 5.573     | 2.40x | 7.81     | 17.535      | 10.753     | 1.63x | 6.78     |
| nested-4         | 9.700      | 3.790     | 2.56x | 5.91     | 8.679       | 4.404      | 1.97x | 4.28     |
| masked-field     | 7.043      | 2.418     | 2.91x | 4.63     | 6.029       | 3.322      | 1.81x | 2.71     |
| error-with-stack | 7.590      | 2.365     | 3.21x | 5.22     | 5.982       | 4.787      | 1.25x | 1.20     |
| deep-chain-1000  | 32.315     | 17.955    | 1.80x | 14.36    | 33.936      | 19.885     | 1.71x | 14.05    |

`array-200` is the weakest row at 1.41x/1.20x; `map-and-set` 2.62x/1.77x, `circular` 2.69x/1.73x and
`shared-ref-twice` 2.55x/1.63x are in `e2e-*.md`.

**Three things that table does not contain**, each measured in isolation and additive to it: the mask
memo (the prototype only precomputes lowercasing, so ~1.0 us more on Bun and ~0.78 on Node for a
12-key entry, projecting flat-5 to roughly 1.2 and 2.5 us), the millisecond timestamp cache (0.112 /
0.546 us), and the `findNestedError` guard, no speedup on any row here but `typed-array-64k` from
20,488 us to under 3.

**Republish: `@arkv/logger` 0.11.0 only.** `@arkv/shared` and `@arkv/colors` are untouched -
`safeStringify` stays where it is, serving `jsonFormat` on the object path -
`@arkv/nestjs-context-logger` needs no code change, and dunx bumps `@arkv/logger` in
`packages/infra/package.json`, adding one name to `packages/infra/src/logger/index.ts` for `logfmt`.
