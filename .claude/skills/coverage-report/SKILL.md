---
name: coverage-report
description: Regenerate the coverage report and badges, or diagnose a wrong percentage, a 404ing badge, or a package showing 0%. Use after adding a package, when coverage numbers look implausible, or when the GitHub Pages coverage site is stale or broken.
---

# /coverage-report

```bash
bun run test:cov      # bun test --coverage from the ROOT, then gen:cov
bun run gen:readme    # only if the package set changed
```

Order matters. `test:cov` must run **once from the repo root** so every package
lands in a single `coverage/lcov.info`; running it per package overwrites that
file with one package's data. `scripts/coverage-report.ts` then turns the lcov
into `coverage/index.html` (per-package breakdown, uncovered line ranges,
packages with no tests), `coverage/coverage.svg`, and a `coverage-<package>.svg`
per package. Zero dependencies.

Badges live in the **root** README's generated Packages table, in the `Coverage`
column added by `scripts/update-readme.ts` — not in per-package READMEs. A new
package picks one up automatically on the next `gen:cov` + `gen:readme`.

Lines and functions only. Bun emits no branch records, so there is no branch
column to add.

## Diagnosing

| Symptom                                       | Cause                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Every badge 404s on GitHub                    | Pages is on the default **Deploy from a branch** source, so GitHub serves a Jekyll render of the README. It must be set to **GitHub Actions** in repo settings.            |
| One package's number is way off               | A sibling import resolved to that sibling's `dist/` and got counted alongside its `src/`. `bunfig.toml` sets `coveragePathIgnorePatterns = ["**/dist/**"]` — check it holds. |
| Package shows grey `no tests`                 | Correct, not a bug — no test files. Grey beats a misleading 0%.                                                                                                          |
| Numbers stale after adding tests              | `gen:cov` ran without a fresh `test:cov`, so it reparsed the old lcov.                                                                                                    |
| New package missing from the table            | `gen:readme` not run after `gen:cov`.                                                                                                                                    |

`ci.yml` publishes `coverage/` to Pages from a separate `pages` job on `main`:
<https://petarzarkov.github.io/dunx>
