---
name: new-package
description: Add a workspace to the dunx monorepo — a published package under packages/ or a private app under examples/ — with correct manifest fields, tsconfig, exports-driven build entrypoints, README, and coverage badge. Use when creating @dunx/http, @dunx/testing, @dunx/create-app, examples/playground, or when adding a public subpath export to an existing package.
---

# /new-package

`packages/core` is the reference. Copy its shape rather than composing a manifest
from memory.

## Published package — `packages/<name>/`

1. **`package.json`** — copy `packages/core/package.json` and change `name` to
   `@dunx/<name>`, `description`, `keywords`, `homepage`, and
   `repository.directory`. Leave the rest alone. The fields that are not optional:
   - `"type": "module"` — without it `verbatimModuleSyntax` raises `TS1287`
     against ESM syntax, and Node treats the shipped ESM as CommonJS
   - `main` + `types` → `dist/` paths, and an `exports` map with `types` and
     `import` conditions. No `module` field, no `require` condition — ESM only
   - `"files": ["LICENSE", "README.md", "dist"]` — without it `src/` ships
   - `version: "0.0.0"` — `scripts/version.ts` owns it from here
   - scripts verbatim: `build`, `test`, `test:cov`, `typecheck`
2. **`tsconfig.json`** — exactly `packages/core/tsconfig.json`: extends the root,
   `include: ["src"]`, `exclude: ["node_modules", "dist"]`. One per package. Do
   not add a build variant.
3. **`src/index.ts`** re-exporting the public surface, `LICENSE`, `README.md`.
4. `bun install` to link the workspace.
5. `bun run build && bun run typecheck && bun run test`.
6. `bun run gen:cov && bun run gen:readme` — picks up the coverage badge and the
   README Packages table row.
7. Add the row to the Packages Overview table in [CLAUDE.md](CLAUDE.md).
8. **First publish must be manual** — see `/release`.

## Adding a public subpath to an existing package

`scripts/build-package.ts` derives entrypoints from the manifest's `exports` and
`bin` fields. That is deliberate: a subpath cannot be added without also being
built. So the manifest edit _is_ the build change — add the `exports` key, then
`bun run build` and confirm the file exists in `dist/`.

## Private example — `examples/<name>/`

Same skeleton, minus publishing: `"private": true`, no `files`, no `exports`, no
`publishConfig`. Depend on packages with `"@dunx/core": "workspace:*"`. Give it a
`start` script — CI asserts examples boot and exit 0.

Per [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) there is **one** growing example,
`examples/playground`, not a new example per phase. Grow that one unless the doc
says otherwise.

## Invariants

- Relative imports carry a `.js` extension. `tsc` copies the specifier verbatim
  into the emitted `.d.ts`; extensionless fails for consumers on
  `node16`/`nodenext`. `moduleResolution: nodenext` makes this a compile error
  here instead of their problem.
- No file over 500 lines. Split before you reach it.
- No `dependencies` unless genuinely required at runtime. Validation-library
  adapters go in `peerDependencies`.

Finish with the `publish-guard` agent — it checks the exports map against real
`dist/` output.
