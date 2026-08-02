# @dunx/testing from another package's tests

**Open, and probably already unblocked.**

`@dunx/testing` can be used by `examples/*` but not by another published package's
tests. The cause was build ordering: `bun run --filter '*' build` ordered by
`dependencies` alone, so a package depending on testing raced its `.d.ts` emit and
failed with `TS7016`.

**That blocker is gone.** `bun run build` is `scripts/build-all.ts`, which orders by
`dependencies`, `peerDependencies` and `devDependencies` and emits waves. The same
change is what made `@dunx/core` and `@dunx/http` peers possible.

This has not been re-tried since. It needs someone to add `@dunx/testing` as a dev
dependency of a package that would benefit and see whether a clean build survives.
`@dunx/openapi` and `@dunx/auth` are the candidates; `@dunx/http` cannot, because
testing depends on it.
