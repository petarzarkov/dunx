# Inter-package peer ranges are exact versions

**Packaging fault. Medium.**

`@dunx/http@0.1.1` declares `peerDependencies: { "@dunx/core": "0.1.1" }` - exact,
because `version.ts` rewrites `workspace:*` to the concrete version. Any skew warns:

```
warn: incorrect peer dependency "@dunx/core@0.1.0"
```

Quiet today because everything is 0.1.1 and lockstep ships all eight together. It
stops being quiet the moment a consumer pins one package explicitly, or installs
across two releases.

A caret would keep lockstep releases silent and make skew tolerable. This is the
same decision as [independent-versions](./independent-versions.md) approached from
the consumer's side, and the pre-1.0 caret problem applies: `^0.1.1` excludes
`0.2.0`, so it helps within a patch series and not across a minor bump.

Found by installing the published packages into a separate repo, which is the only
way this surfaces - a monorepo never sees it.
