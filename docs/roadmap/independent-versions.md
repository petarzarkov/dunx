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

`version.ts` rewrites `workspace:*` to an **exact** version. That is correct under
lockstep and wrong under independent versions: `@dunx/http@0.3.0` pinning
`@dunx/core@0.2.0` exactly would fight `@dunx/infra@0.4.0` pinning `0.3.0`, and a
peer conflict is a hard install failure rather than the silent duplication that
`dependencies` produced.

So the decision is a **range policy**, and it is genuinely a decision:

- A caret does not work pre-1.0. `^0.1.0` excludes `0.2.0`, so a minor bump of core
  fragments the graph anyway. This is already recorded as rejected in
  ARCHITECTURE.md.
- `>=x.y.z` works but promises forward compatibility across majors, which is a
  promise dunx cannot keep before 1.0.
- Post-1.0 a caret is correct and this becomes easy.

**The honest answer may be to wait for 1.0.** Lockstep's only cost is that an
untouched package takes a version, and for a pre-1.0 framework whose packages move
together that is arguably a feature: one number answers "which versions work
together".
