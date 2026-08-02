# Tell consumers to pin every @dunx package to the same minor

**Documentation. Found consuming the published packages, not reading the code.**

Lockstep publishing keeps versions moving together on **our** side. It does not stop
a consumer's own ranges resolving them apart.

Reproduced in `dunx-template` with every dependency declared `^0.2.0` while the
registry had 0.2.5:

```
warn: incorrect peer dependency "@dunx/http@0.2.0"
```

bun resolved `@dunx/auth` to 0.2.5 and kept the other six at 0.2.0, because the
lockfile already had an entry for them and `^0.2.0` permits it. `@dunx/auth@0.2.5`
peers on `@dunx/http@^0.2.5`, which `0.2.0` does not satisfy.

The caret peer ranges are what made this visible rather than silent, which is an
argument for them - an exact pin would have produced `ERESOLVE` or a nested second
copy of core instead of a warning. But the failure mode is still a real one a
consumer will hit, and nothing tells them.

## What to write

A short note wherever installation is described - `docs/guide/02-first-steps.md`,
the root README, and `@dunx/create-app`'s generated README:

> Install every `@dunx/*` package at the same version. They release in lockstep and
> peer-depend on each other by caret range, so mixing minors resolves to a graph
> that warns on install and can end up with two copies of `@dunx/core`, which
> breaks dependency injection outright: a token is a class object, and two copies
> means two different classes.

`@dunx/create-app`'s template already writes one version for all of them, so the
scaffolded case is correct. This is for someone adding a second package by hand
later.

Worth considering alongside: a runtime check in `@dunx/core` that detects two copies
of itself and fails at boot with that explanation, rather than leaving it as a
missing-binding error somewhere unrelated.
