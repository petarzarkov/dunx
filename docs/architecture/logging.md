# Logging

`@arkv/logger` bound to core's `Logger` contract, and where a fix belongs when the boundary makes it ambiguous.

## Colour in `@dunx/infra/logger`, and where the fix belongs

`LoggerModule.forRoot()` used to write ANSI escapes into its JSON whenever stdout was
not a terminal, which makes the logs unparseable for anything downstream. Measured:
with `Bun.enableANSIColors === false` and `process.stdout.isTTY === undefined`, a
default entry came out as `{\u001b[36m"level":\u001b[39m...`, 26 escapes in one line.
Neither `NO_COLOR=1` nor `FORCE_COLOR=0` suppressed it.

The cause is upstream and it is not an edge case. `@arkv/logger` picks the pretty
formatter from `isDevelopment`, which defaults to `process.env.NODE_ENV !== 'production'`,
and **nothing on the colour path asks whether the output is a terminal** - not the
logger, `ConsoleTransport` and the formatter alike. So the zero-argument
`LoggerModule.forRoot()` in a container with `NODE_ENV` unset hit it, beyond just an app
that passed `isDevelopment: true`.

This split cleanly along the boundary CLAUDE.md already draws, so both halves were
done rather than one:

- **dunx supplies the default, because the good answer is Bun-specific.**
  `isDevelopment` now defaults to `Bun.enableANSIColors`, which already folds in TTY
  detection, `NO_COLOR` and `FORCE_COLOR`. That is not a patch, a wrapper or a
  vendored copy - it is dunx choosing the default for an option upstream exposes, and
  a consumer passing `isDevelopment` still wins. `Bun.enableANSIColors` is also
  strictly the better question: upstream's option controls colour and nothing else,
  so `NODE_ENV` was never what it wanted to know.
- **The portable gate belongs upstream and stays there.** `@arkv` targets Node and
  the web, so it cannot use `Bun.*`; its own `@arkv/colors` already exports
  `isColorSupported()` and nothing in the logger calls it. That proposal, with the
  exact call site and a second defect it turned up (`FORCE_COLOR=0` is read as
  presence, so it forces colour _on_), shipped upstream in `@arkv/logger` 0.8.2.

The two compose: once the upstream gate lands, dunx's default is still the right one
and nothing here has to be undone. `packages/infra/src/logger/module.test.ts` asserts
the entry is coloured **exactly when** `Bun.enableANSIColors` is true, which holds at
a terminal and in a pipe and fails on the old default.

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

The red `{` is the part to record, the obvious explanation being wrong. It
is not the terminal: **Bun wraps `console.error` output in red itself**, emitting
`\u001b[0m\u001b[31m` before the line and `\u001b[0m` after. Every token the formatter
colours overrides that wrapper; every character it leaves bare keeps it. So the fix is
not only to tokenise but to colour the punctuation too, which nothing did before.

The fix is a scanner over `safeStringify`'s output rather than a re-serialisation, so
escapes are only ever _inserted_ and the stripped bytes stay byte-identical - which is
what keeps a pretty line parseable, and gets every `JSON.stringify` edge case
(dropped `undefined`, `toJSON`, non-finite numbers, the circular fallback) for free.

**Upstream, in `~/repos/arkv/packages/logger/src/format.ts`,** per Rule 1: it needs no
`Bun.*` API, it is a defect every `@arkv/logger` consumer has, and a local wrapper
would have forked a package the owner maintains.

## What else of `@arkv` dunx uses, and what it does not

The workspace was read end to end against the question that matters: is dunx doing
something worse than a package the owner already maintains? Nothing to adopt came
back, and the two standing candidates both died on inspection.

| package           | in dunx                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@arkv/logger`    | Used, bound to core's `Logger` contract by `@dunx/infra/logger`.                                                                                                                                                |
| `@arkv/colors`    | Used, through the logger.                                                                                                                                                                                       |
| `@arkv/timezones` | First choice for any date or zone handling. No such need has arisen.                                                                                                                                            |
| `@arkv/rng`       | **Not used.** It is WASM-backed, and dunx needs ids rather than statistics: `Bun.randomUUIDv7` and `crypto.randomUUID` are native and measured at 0.04 us, so adopting it would trade a native call for weight. |
| `@arkv/shared`    | Not used. Fifteen runtime symbols; dunx has a need for none of them.                                                                                                                                            |

**Backoff was the first candidate, and the premise was wrong.** It is implemented
once in dunx, in the websocket relay's resubscribe - the queue does not
retry, bullmq does. And there is nothing upstream to share with: `@arkv/shared`'s
`retry` takes a constant delay with no multiplier, jitter, cap or signal, and a
workspace-wide grep for `backoff|jitter|exponential|circuit` returns nothing.

**Redaction was the second.** `sanitizeLogEntry` is real and good, and as of
`@arkv/logger` 0.8.2 it is exported. dunx still does not consume it: `@dunx/core`
having zero dependencies is load-bearing, and `ConsoleLogger` not sanitizing is
precisely the reason to swap in `@dunx/infra/logger`.

Three fixes did go the other way, the direction the rule points in - a
colour-support gate, `FORCE_COLOR=0` no longer forcing colour _on_, and that
sanitizer export. All three shipped in 0.8.2 rather than being patched here.
