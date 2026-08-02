# Independent versions on top of peer dependencies

**Open. The prerequisite is done.**

`@dunx/core` and `@dunx/http` are `peerDependencies` of every package that uses
them, each with a matching `devDependency` supplying the workspace link. That was
roadmap item 1 and it is finished.

Versioning is still **lockstep**: all eight packages share one number and ship
together. Peers and lockstep solve different halves, so this is not redundant - a
peer cannot be duplicated by the installer, and lockstep keeps the exact version
`version.ts` writes into the peer range coherent across the set.

## What independent versions still need

**Half of this is now done, and it is the half that was a defect either way.** The
publish path used to rewrite `workspace:*` to an **exact** version, which warned on
any skew even under lockstep; it now writes `^<version>`, from one shared function
(`resolveWorkspaceRange` in `scripts/workspace-ranges.ts`) that `version.ts` and
`first-publish.ts` both call. The reasoning is in ARCHITECTURE.md, "Versioning is
lockstep".

What that did **not** settle is the range policy independent versions need, because
the caret is only sound while lockstep guarantees it is never stale:

- A caret does not work pre-1.0. `^0.1.0` excludes `0.2.0`, so `@dunx/http@0.3.0`
  naming `@dunx/core@^0.2.0` would fight `@dunx/infra@0.4.0` naming `^0.3.0`, and a
  peer conflict is a hard install failure rather than the silent duplication that
  `dependencies` produced. This is already recorded as rejected in ARCHITECTURE.md.
- `>=x.y.z` works but promises forward compatibility across majors, which is a
  promise dunx cannot keep before 1.0.
- Post-1.0 a caret is correct and this becomes easy.

**The honest answer may be to wait for 1.0.** Lockstep's only cost is that an
untouched package takes a version, and for a pre-1.0 framework whose packages move
together that is arguably a feature: one number answers "which versions work
together".
