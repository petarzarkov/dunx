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
logger, not `ConsoleTransport`, not the formatter. So the zero-argument
`LoggerModule.forRoot()` in a container with `NODE_ENV` unset hit it, not just an app
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
  presence, so it forces colour _on_), is in `docs/roadmap/arkv-integrations.md`.

The two compose: once the upstream gate lands, dunx's default is still the right one
and nothing here has to be undone. `packages/infra/src/logger/module.test.ts` asserts
the entry is coloured **exactly when** `Bun.enableANSIColors` is true, which holds at
a terminal and in a pipe and fails on the old default.
