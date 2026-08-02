# The cost of request validation

Reading the body costs about three times as much as validating it. Measured, with the harness that attributes it.

## The cost of request validation (`tools/bench` validation harness)

`bun run validation` in `tools/bench` is a second harness, separate from
`bun run start`, because the main suite deliberately cannot answer two questions: it
holds the validator constant at zod so `validate` minus `json` reads as one
framework's plumbing, which folds **the absolute cost of parsing and validating**
together with **dunx's own overhead**. This one separates them. `servers/validation/`
has two subjects - raw `Bun.serve` and a dunx app - each serving routes that add one
step at a time, and `$VALIDATOR` swaps the library behind `~standard` without
changing anything else.

**The first version of this harness measured each row to completion in turn, and that
was wrong.** The differences it exists to report are 2-4%, and the machine's own
throughput drifts by more than that over the minutes a run takes - so the drift landed
on whichever row happened to be measured while it was happening. It produced
`raw:parse` as _slower_ than `raw:noop`, which does strictly more work, and several
negative validator costs. The runner now brings every unit up first and measures them
**round-robin**, which spreads the drift across all rows equally; the ordering came out
monotonic on the first attempt afterwards. Noise floor at this throughput is about
**±0.3 µs**, and figures below it are reported rather than clamped.

### Parsing costs 3x what validating costs

| Step                                     | µs/req | adds     |
| ---------------------------------------- | -----: | -------- |
| `GET /json`, no request body             |   8.78 | -        |
| `POST`, body on the wire, **never read** |   9.05 | +0.27 µs |
| `POST` + `await req.json()`              |  12.14 | +3.10 µs |
| `POST` + `req.json()` + zod              |  13.09 | +0.94 µs |

Putting a body on the wire is near-free; reading it is 3.10 µs and validating it is
0.94 µs. The ~30% drop from the `json` scenario to the `validate` scenario that every
subject in the main suite pays is therefore **77% `req.json()` and 23% zod**. The
primitive that would fix it is a validating parser Bun does not ship - recorded in
[bun-apis.md](./bun-apis.md), along with why dunx must not write one.

### Every validator is cheaper than the parse

The same dunx app, the same schema shape, only the library behind `~standard`
changed. Cost is that validator's own time, taken as the raw `Bun.serve` subject's
µs/req above the `req.json()`-only row:

| Validator                   |    costs | `~standard` |
| --------------------------- | -------: | ----------- |
| TypeBox, `TypeCompiler` AOT | −0.01 µs | bridged     |
| ajv, compiled JSON Schema   |  0.34 µs | bridged     |
| ArkType                     |  0.42 µs | native      |
| Valibot                     |  0.89 µs | native      |
| zod                         |  0.94 µs | native      |

**zod, Valibot and ArkType are within noise of each other**, and both compiled options
land at or under the noise floor - TypeBox's compiled checker is indistinguishable
from not validating at all on a three-field payload. All five are under the 3.10 µs
the parse costs, so **there is no throughput argument for steering a user off zod**: a
0.9 µs saving on a request that takes 13 µs is 7%, against giving up zod's ecosystem,
error messages and `z.toJSONSchema` (which `@dunx/openapi` uses). The advice this
produces is "pick on API, not on this table", and the table exists so that advice is
checkable. It would very likely read differently on a deeply nested schema, where
compiled straight-line code diverges from an interpreter far more than at this size -
which is a limitation of the payload, and is recorded in the harness's README.

Neither TypeBox 0.34 nor ajv 8 exposes `~standard`. Both were bridged in about ten
lines each in `servers/validation/schemas.ts` - a boolean `Check` plus their error
iterator, wrapped in a `~standard.validate`. That a compiled JSON Schema checker
drops into a dunx route with no change to `@dunx/http` is the payoff of targeting an
interface instead of a library, and it is worth knowing it was tested rather than
assumed. Valibot and ArkType need no bridge; ArkType's `ArkErrors` is an `Array`
subclass with an `issues` getter, which the existing code already handles.

### Where dunx's 11 points went: async machinery, not validation

The main suite's `validate` row sat at **84.0% of raw `Bun.serve`** while `json` sat
at 95.3%. Splitting dunx's side the same way - two extra dunx routes that declare no
schemas and do the parse and the validation inside the handler, so they stay on the
synchronous dispatch path - located it. Measured **before** the changes below:

| Subject                                       | µs/req | dunx's share        |
| --------------------------------------------- | -----: | ------------------- |
| raw `Bun.serve`, parse in the handler         |  11.89 | -                   |
| dunx, no schemas, parse in the handler        |  13.06 | 1.17 µs dispatch    |
| dunx, no schemas, validate in the handler     |  14.56 | + zod               |
| dunx, `body` declared - the framework does it |  16.62 | **+2.05 µs reader** |

**The input reader cost 2.05 µs - nearly twice what zod itself cost.** An in-process
microbenchmark against a fake request (so no real parse is involved) put the reader's
plumbing at **597 ns/request with a no-op schema**, against ~250 ns for zod's actual
`validate` on the same payload.

The cause was async machinery on values that were never promises - the same fault the
`plaintext` fast path had, one layer down. A route with a declared `body` went through
six `async` frames: `guarded`, `chained`, the reader, the fold step, `readBody`, and
`validated`. Exactly one of them, `req.json()`, ever had anything to wait for.
Standard Schema _permits_ `~standard.validate` to return a promise, and none of zod,
Valibot or ArkType ever does - verified, all three return a plain object.

Three changes, each measured:

1. **`packages/http/src/server/input.ts`: nothing is `async` any more.** `Fill` is
   `(draft) => InputDraft | Promise<InputDraft>` and every step looks at what it got
   instead of awaiting it. A `query`- or `params`-only route with a synchronous
   validator now returns the input **with no promise at all**; a `body` route pays one
   promise link on `req.json()` instead of six frames. The `then` fold returns the
   draft rather than `void` precisely so the reader can be `(req) => fill({ req })` -
   threading the draft back through a second `then` cost a measurable 58 ns.
   `mediaTypeOf` also short-circuits on a verbatim `application/json` header rather
   than slicing, trimming and lowercasing it: worth ~70 ns when the header is bare.
2. **`packages/http/src/server/routes.ts`: the direct dispatch path now covers routes
   that read input.** It used to require `readsNothing`; the condition is now just "no
   middleware and no CORS", and `readsNothing` is gone because the general code
   collapses to it. `read`, the handler and the response coercion are each adopted
   rather than awaited.
3. **A `query` route stopped parsing the whole URL, and `grouped` stopped iterating.**
   `new URL(req.url).searchParams` resolved scheme, host, port, path and fragment to
   reach a query string, then built a `URLSearchParams` anyway - measured at **~1,040
   of the ~1,520 ns** a three-pair query route cost, which was more than the entire
   body reader. An `indexOf('?')` slice into `new URLSearchParams` removes the URL
   parse; the fragment is still stripped, because `new URL` stripped it and a
   request-target that carries one should not change what a schema sees.
   `RequestLoggingMiddleware` had taken exactly this slice for exactly this reason -
   the same fault twice, in two files, found the same way.

   `grouped` then switched from `for…of` destructuring to `forEach`, which both
   `URLSearchParams` and `FormData` implement natively: destructuring an iterator
   allocates a two-element array per entry, and dropping it was worth another ~140 ns.
   Together: **1,520 -> 1,024 ns**, a third of a query route's cost.

   What is left is `new URLSearchParams(search)` at ~624 ns, and it stays. Splitting
   on `&`/`=` and calling `decodeURIComponent` by hand would be faster and is exactly
   what Rule 1's first half forbids: a JavaScript reimplementation of a Web standard
   Bun implements natively, with `+`-versus-`%20`, repeated keys, empty values and
   malformed escapes to get wrong.

Measured one change at a time, as dunx's own overhead per request on the zod validate
route:

| Stage                     | dunx overhead | dunx vs raw |
| ------------------------- | ------------: | ----------: |
| before                    |       3.66 µs |       78.0% |
| after the reader change   |       2.64 µs |       83.0% |
| after the dispatch change |       1.40 µs |       90.3% |

In the main suite that is **`validate` 84.0% -> 92.3% of raw `Bun.serve`**, which also
puts dunx **9 points ahead of Elysia** on the one scenario where it used to be level
(Elysia is at 83.2% in the same run). The reader now costs _less_ than doing the same
work by hand in a handler - the "framework does it" row comes out 0.19 µs **below**
the hand-written one, inside the noise floor, which is the honest reading of "no longer
costs anything". The microbenchmark agrees and can resolve it: the reader's plumbing
went from **597 ns to 146 ns** with a no-op schema, a 4.1x improvement, and a
`params`-only route with a synchronous validator reads and validates in **56 ns** with
no promise allocated at all.

Nothing about the `json`, `params` or `plaintext` rows moved, which is the check that
changes 1 and 2 are confined to routes that declare a schema.

Change 3 has **no HTTP evidence at all**, and that is a gap rather than a detail:
neither harness has a route with a declared `query` schema - the main suite's `params`
scenario reads `input.req.params` with no schema, so it never touches the query path.
The 1,520 -> 1,024 ns is microbenchmark-only, and the right fix is a `query` scenario
in the harness rather than a larger claim here.

### Tried and rejected: a specialised single-schema reader

Most routes declare exactly one schema, so the fold and the shared `InputDraft` are
avoidable: a hand-written body-only reader that builds `{ req, body }` as one literal
and calls `~standard.validate` inline measured **306 ns/request against the shipped
reader's 394 ns** on the same microbenchmark - a real, repeatable 88 ns.

Rejected. 88 ns is 0.6% of a 14 µs request, which is **below the noise floor of the
HTTP harness** (run-to-run stddev is 1-3%), so the win cannot be demonstrated at the
level anyone experiences it - and unlike the `forEach` change above, which is a
comparable 140 ns, it does not pay for itself in simplicity. It would need one code
path per declared combination to be consistent, and would duplicate the 415 and 400
handling that `bodyFill` owns, where `forEach` replaced a `for…of` with fewer moving
parts than it had before. That asymmetry is the rule this file is applying: a
sub-noise-floor win is worth taking when the code gets simpler and not when it
does not.

Also rejected: pre-seeding the draft with the declared keys set to `undefined` so the
property stores do not transition the object's shape. It changes `Object.keys(input)`
for a route whose validator rejects, which is observable, for a fraction of the 88 ns
above.

### What still costs, and why it is not obviously fixable

dunx's remaining ~1.3 µs on this route is **dispatch, not validation**: a dunx route
whose handler does the parse itself still costs 1.17 µs over the identical raw
`Bun.serve` handler, and the input reader now adds almost nothing on top. That
residue is the closure indirection and the one extra promise link needed to adopt a
handler's return value. Removing it means generating per-route source and `eval`-ing
it, which is Elysia's approach; it would trade a readable dispatch path for a code
generator, and at 1.3 µs on a request whose parse alone is 2.9 µs it is not the next
thing worth doing.
