---
name: release
description: Version and publish @dunx/* packages to npm. Use when cutting a release, when a publish failed or a package is missing from npm, when a package needs its first npm version, or when touching scripts/version.ts, the pinned npm version, or the publish job in ci.yml.
---

# /release

Releases are **lockstep**: every `@dunx/*` package shares one version and ships
together, even the ones a release did not touch. Change detection decides _whether_
to release, never _what_. The reason is a correctness one — `version.ts` rewrites
`workspace:*` to an **exact** version at publish time, so independent versions would
let an app end up with two copies of `@dunx/core`, and in this container a token _is_
a class object. Full reasoning: ARCHITECTURE.md, "Versioning is lockstep".

**Do not make versions independent again** without also solving the duplicate-core
problem — see that section for the two alternatives and why each was rejected.

CI runs `bun run version` on every push to `main` and
publishes any package whose version changed. There is normally nothing to run by
hand. This skill is for cutting a release deliberately, and for the failure modes.

## Cutting a release

1. `/ci-check` — build, lint, typecheck, test. A failed build publishes nothing,
   but a passing build with broken `dist/` publishes broken.
2. Run the `publish-guard` agent over the changed packages.
3. `bun run version:dry-run` — read the computed bumps. Conventional commits:
   `feat:` → minor, `fix:` → patch, `BREAKING CHANGE` → major.
4. Push to `main`. CI does the rest.

Force every package to publish regardless of computed bumps by putting
`[force-publish]` in the commit message.

## Constraints that are load-bearing

- **Trusted publishing (OIDC), no `NPM_TOKEN`.** Each package's trusted publisher
  on npmjs.com is pinned to the workflow **filename** `ci.yml`. Renaming that file
  silently breaks publishing for every package. `ci.yml` is the only workflow
  permitted to publish.
- **npm is the one sanctioned non-bun tool**, only inside `scripts/version.ts`:
  `bun publish` cannot authenticate via OIDC (oven-sh/bun#15601). It runs as
  `bunx npm@<pinned>` — the `NPM` constant, currently `bunx npm@11.10.1`. Bun
  executes npm on its own runtime, so CI needs no `setup-node`. The pin must stay
  **>= 11.5.1**; `ubuntu-latest` still ships npm 10.x, so the pin is doing real
  work. Bump the constant to upgrade.
- **`workspace:` ranges.** `npm publish` does not expand them, so `version.ts`
  rewrites them to concrete versions around the publish and restores
  `package.json` afterwards. If a publish dies mid-run, check `git diff` for a
  package manifest left with concrete versions where `workspace:*` belongs. Under
  lockstep an exact pin is the _desired_ result, so `workspace:*` is correct and
  `workspace:^` is not — a caret cannot span a pre-1.0 minor bump anyway.
- **`--provenance` only under `GITHUB_ACTIONS`.** It errors anywhere else, which
  would break a manual publish.

## Failure modes

| Symptom                                         | Cause                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First publish of a new package fails in CI      | A package with no versions on npm has no trusted-publisher settings page yet. Run `bunx npm@11.10.1 login` then `bun scripts/first-publish.ts` — **not** a bare `npm publish`, which ships `workspace:*` verbatim and breaks every consumer install. |
| `dist-tag`, `deprecate`, `access` fail in CI    | Only `npm publish` can use the OIDC credential. Run these locally against a personal npm login.                                                                                                                                                      |
| Published tarball contains `src/` or test files | Missing or wrong `files` in the manifest. `publish-guard` catches this.                                                                                                                                                                              |
| Consumer on `node16`/`nodenext` cannot resolve  | An extensionless relative specifier reached the emitted `.d.ts`. Every relative import in source needs a `.js` extension.                                                                                                                            |
| CI publishes nothing and reports success        | No version changed. Expected — check the dry-run output.                                                                                                                                                                                             |

## Never

Do not add `NPM_TOKEN`, a second publishing workflow, or `npm` calls outside
`scripts/version.ts`.
