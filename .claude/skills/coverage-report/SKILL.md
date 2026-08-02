---
name: coverage-report
description: Regenerate the coverage report and badges, or diagnose a wrong percentage, a 404ing badge, or a package showing 0%. Use after adding a package, when coverage numbers look implausible, or when the GitHub Pages coverage site is stale or broken.
---

# /coverage-report

```bash
bun run test:cov      # bun test --coverage from the ROOT, then gen:cov
bun run docs:build    # the site is what carries the report and the badges
bun run gen:readme    # only if the package set changed
```

Order matters. `test:cov` must run **once from the repo root** so every package
lands in a single `coverage/lcov.info`; running it per package overwrites that
file with one package's data.

`scripts/coverage-report.ts` then turns the lcov into two things, both **inside
`tools/docs`** - the site is the Pages root, coverage is a page in it:

- `tools/docs/src/generated/coverage.json` - the model the Coverage page
  renders (per-package breakdown, uncovered line ranges, packages with no tests)
- `tools/docs/public/badges/coverage.svg` plus a `coverage-<package>.svg` each,
  which the build copies verbatim to `/badges/` in the built site

Zero dependencies. It writes no HTML of its own any more; `bun run docs:build`
has to run afterwards for either output to reach the deployed site. CI does that
in the `Build the documentation site` step, which sits after `test:cov` for
exactly this reason.

Badges live in the **root** README's generated Packages table, in the `Coverage`
column added by `scripts/update-readme.ts` - not in per-package READMEs. A new
package picks one up automatically on the next `gen:cov` + `gen:readme`.

Lines and functions only. Bun emits no branch records, so there is no branch
column to add.

## Diagnosing

| Symptom                               | Cause                                                                                                                                                                        |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every badge 404s on GitHub            | Pages is on the default **Deploy from a branch** source, so GitHub serves a Jekyll render of the README. It must be set to **GitHub Actions** in repo settings.              |
| One package's number is way off       | A sibling import resolved to that sibling's `dist/` and got counted alongside its `src/`. `bunfig.toml` sets `coveragePathIgnorePatterns = ["**/dist/**"]` - check it holds. |
| Package shows grey `no tests`         | Correct, not a bug - no test files. Grey beats a misleading 0%.                                                                                                              |
| Numbers stale after adding tests      | `gen:cov` ran without a fresh `test:cov`, so it reparsed the old lcov.                                                                                                       |
| New package missing from the table    | `gen:readme` not run after `gen:cov`.                                                                                                                                        |
| Coverage page says "no coverage data" | The site was built before `gen:cov` ran. `bun run test:cov && bun run docs:build`.                                                                                           |
| Badges 404 but the site loads         | They are at `/badges/coverage-<pkg>.svg` now, not the Pages root. Check `scripts/update-readme.ts`'s `DOCS_SITE`.                                                            |

`ci.yml` publishes `tools/docs/dist/` to Pages from a separate `pages` job on
`main`: <https://petarzarkov.github.io/dunx>, with the report at
<https://petarzarkov.github.io/dunx/#/coverage>.
