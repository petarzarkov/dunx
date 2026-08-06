---
name: new-package
description: Add a workspace to the dunx monorepo - a published package under packages/, a published CLI under tools/, a private workspace under internal/, or an example under examples/ - with correct manifest fields, tsconfig, exports-driven build entrypoints, README, and coverage badge. Use when creating @dunx/http, @dunx/testing, @dunx/create-app, examples/full, or when adding a public subpath export to an existing package.
---

# /new-package

`packages/core` is the reference. Copy its shape rather than composing a manifest
from memory.

## Pick the parent first

| Parent      | For                                             | Published | Reference          |
| ----------- | ----------------------------------------------- | --------- | ------------------ |
| `packages/` | framework an app **imports**                    | yes       | `packages/core`    |
| `tools/`    | a CLI a consumer **runs** (`bunx @dunx/<name>`) | yes       | `tools/mcp`        |
| `internal/` | repo-only: site, harness, bundle, shared UI     | **no**    | `internal/ui`      |
| `examples/` | an app that consumes the packages               | no        | `examples/minimal` |

Two lists decide what publishes, and both must name a new **published** parent -
they are the only places that know: `PUBLISHABLE_DIRS` in `scripts/version.ts` and
`PUBLISHED_DIRS` in `scripts/update-readme.ts`. `private: true` is what actually
stops a publish, so getting the parent wrong fails safe.

A workspace with **no `build` script is skipped** by `scripts/build-all.ts`, which
is how `internal/ui` ships as source with its `exports` pointing at `src/`.

## Published package - `packages/<name>/` or `tools/<name>/`

1. **`package.json`** - copy `packages/core/package.json` and change `name` to
   `@dunx/<name>`, `description`, `keywords`, `homepage`, and
   `repository.directory` - the last two carry the parent, so `tools/<name>`
   rather than `packages/<name>` for a CLI. Leave the rest alone. The fields that are not optional:
   - `"type": "module"` - without it `verbatimModuleSyntax` raises `TS1287`
     against ESM syntax, and Node treats the shipped ESM as CommonJS
   - `main` + `types` → `dist/` paths, and an `exports` map with `types` and
     `import` conditions. No `module` field, no `require` condition - ESM only
   - `"files": ["LICENSE", "README.md", "dist"]` - without it `src/` ships
   - `version: "0.0.0"` - `scripts/version.ts` owns it from here
   - scripts verbatim: `build`, `test`, `test:cov`, `typecheck`
2. **`tsconfig.json`** - exactly `packages/core/tsconfig.json`: extends the root,
   `include: ["src"]`, `exclude: ["node_modules", "dist"]`. One per package. Do
   not add a build variant.
3. **`src/index.ts`** re-exporting the public surface, `LICENSE`, `README.md`.
4. `bun install` to link the workspace.
5. `bun run build && bun run typecheck && bun run test`.
6. `bun run gen:cov && bun run gen:readme` - picks up the coverage badge and the
   README Packages table row.
7. Add the row to the Packages Overview table in [CLAUDE.md](../../../CLAUDE.md).
8. **First publish must be manual** - see `/release`.

## Adding a public subpath to an existing package

`scripts/build-package.ts` derives entrypoints from the manifest's `exports` and
`bin` fields. That is deliberate: a subpath cannot be added without also being
built. So the manifest edit _is_ the build change - add the `exports` key, then
`bun run build` and confirm the file exists in `dist/`.

## Private example - `examples/<name>/`

Same skeleton, minus publishing: `"private": true`, no `files`, no `exports`, no
`publishConfig`. Depend on packages with `"@dunx/core": "workspace:*"`.

**Name it `@dunx/example-<dir>`.** CI reaches every example through
`bun run --filter '@dunx/example-*' test`, so an off-pattern name is an example
that silently stops being checked. It needs a `bunfig.toml` with the compiler
preload under both the root and `[test]`, a `tsconfig.json` extending the root, a
`typecheck` script, and a **`test` script with at least one test** - `--filter`
matches only workspaces that have the script, so an example without one is skipped
without saying so.

There are four, and they are **not one per package** - they are a ladder of
questions an evaluator asks in order (`minimal` → `databases` / `testing` →
`full`). Per-package examples were tried and reverted; that reversal holds. Before
adding a fifth, read docs/ARCHITECTURE.md, Phase 1, which records which candidates
were rejected and why:

- `examples/full` is the _integration_ example. It grows through the phases and is
  the only place the packages are shown composing. Do not fork it per phase, and do
  not carve pieces out of it into new examples.
- `examples/minimal` is valuable only because it is small. Do not add to it.
- A new example must answer a **question the existing four do not**, and must be
  keepable alive by CI. If its whole subject needs a service CI does not have, it
  would demonstrate nothing there - that is a rejection, not a caveat.

An example that needs a service CI does not have (Redis, Postgres, MySQL, S3,
network) must detect that, print a clear "skipping" line, and **still exit 0**. An
example that cannot run is an example nobody notices has rotted.

## Invariants

- Relative imports carry a `.js` extension. `tsc` copies the specifier verbatim
  into the emitted `.d.ts`; extensionless fails for consumers on
  `node16`/`nodenext`. `moduleResolution: nodenext` makes this a compile error
  here instead of their problem.
- No file over 500 lines. Split before you reach it.
- No `dependencies` unless genuinely required at runtime. Validation-library
  adapters go in `peerDependencies`.

Finish with the `publish-guard` agent - it checks the exports map against real
`dist/` output.
