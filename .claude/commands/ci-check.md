Run every CI gate with one command.

1. **`bun run ci`**

That is `scripts/ci.ts`. It builds first, then runs the `static`, `unit`,
`examples`, `docs` and `coverage` phases at the same time, which is what the jobs
in `.github/workflows/ci.yml` run and in the same commands. `scripts/ci.test.ts`
fails if the two ever drift apart.

Each step's output is captured and printed only when that step fails, so read the
summary at the end: it counts the steps, names every failure and prints its
output. Fix, then rerun. While iterating on one failure, `bun run ci <phase>`
runs just that phase; `bun run ci --list` names them.

Do not stand in `bun run build`, `bun run lint`, `bun run typecheck` and
`bun run test` for it. `lint` and `format` fix in place, so they pass where CI
fails, and those four miss `format:check`, `gen:readme --check`,
`check:scaffolds`, every example, the tour, the docs suite and the coverage
model.

Report the result plainly, with the failing step's own output when there is one.
