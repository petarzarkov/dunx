# The benchmark harness degrades silently without oha

**Bug. Found while trying to verify a microsecond-level change.**

`oha` lives at `tools/bench/.bin/oha`, installed by `bun run setup`, and is
gitignored. A fresh checkout or a git worktree therefore does not have it, and
`tools/bench/src/loadgen/index.ts` falls back to a built-in `fetch` generator
**without saying that the numbers are now unusable**.

Measured in a worktree with no `.bin/oha`: the fallback capped at 14-65k req/s
against oha's recorded 115k for the same `off` row, with standard deviations of
17-30k, and rows in scrambled order - `requestid` came out faster than the
`requestLogging: false` baseline it is strictly slower than. Two full runs, both
worthless.

That is not a slow generator, it is a generator that cannot resolve what the
harness exists to measure. `bun run logging` decomposes request logging into steps
worth 0.04 to 2.04 microseconds each; a generator with a 20k req/s standard
deviation cannot see any of them.

## Fix

`bun run logging` and `bun run start` should **refuse to run** when the resolved
generator is the fallback, with the message being `bun run setup`. An explicit
`--allow-fallback` for someone who genuinely wants a smoke test is fine; the
default must not be a plausible-looking table nobody can trust.

Worth pairing with a note in the report JSON: `loadGenerator.id` already records
which generator ran, so a published result carrying the fallback is detectable
after the fact, but nothing currently looks.
