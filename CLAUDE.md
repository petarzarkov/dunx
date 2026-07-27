# dunx — Claude Code Instructions

dunx is a Bun-native dependency injection framework. Read
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) before making design decisions —
it records what was measured, what was rejected, and why.

## Runtime & Package Manager

- **Bun** is the only runtime and package manager. Never use `npm`, `npx`, `yarn`, or `pnpm`.
- Run packages/tools with `bunx` (e.g. `bunx oxlint`).
- Run scripts with `bun run <script>`.
- Execute TypeScript files directly with `bun <file.ts>`.
- Install dependencies with `bun install` (use `--frozen-lockfile` in CI).

## Monorepo Structure

```
packages/<name>/        # Each published package
  src/                  # Source TypeScript
  dist/                 # Build output (gitignored)
  package.json
  tsconfig.json         # Extends ../../tsconfig.json — one per package, no build variants
examples/<name>/        # Private example apps that consume the packages
docs/                   # Architecture and design docs
scripts/                # Repo-level scripts (bun-native TS)
.github/workflows/      # CI (ci.yml)
```

Package scope: `@dunx/<name>`. Every package is **ESM only** and emits a single
`dist/` containing JS plus `.d.ts`.

## Decorators — standard only

- The root tsconfig deliberately does **not** set `experimentalDecorators` or
  `emitDecoratorMetadata`. Do not add them.
- Use TC39 standard decorators. There are no parameter decorators in that
  proposal, so constructor-parameter injection is not available by design.
- Do not add `reflect-metadata` or `tsyringe`. DI is `inject()` in field
  initializers; see docs/ARCHITECTURE.md.

## Building

```bash
bun run build         # all packages: bun run --filter '*' build
```

Within a package, `build` is `bun ../../scripts/build-package.ts`. That script:

- derives entrypoints from the manifest's `exports` and `bin` fields, so a new
  public subpath cannot be added without also being built
- emits JS with `Bun.build` (`target: bun`, `format: esm`,
  `packages: 'external'`, linked source maps)
- emits `.d.ts` with `tsc --emitDeclarationOnly` — Bun has no `--dts`
- prunes `*.test.d.ts` / `*.spec.d.ts` from `dist/`, since one tsconfig serves
  both typecheck and build

Relative imports **must** carry a `.js` extension. `tsc` copies the specifier
verbatim into the emitted `.d.ts`, and an extensionless one fails to resolve for
consumers on `node16`/`nodenext`. `moduleResolution: nodenext` in the root
tsconfig makes this a compile error rather than a consumer's problem.

Every package manifest needs `"type": "module"`. Without it,
`verbatimModuleSyntax` raises `TS1287` against ESM syntax.

## Linting & Formatting

- **Linter**: `oxlint` (config: `.oxlintrc.json` at repo root)
- **Formatter**: `oxfmt` (config: `.oxfmtrc.json`)
- `bun run lint` / `bun run format` fix in place; `lint:check` / `format:check`
  do not and are what CI runs.
- Pre-commit hook runs lint-staged: lints then formats staged `.ts` files.
- There is no ESLint or Biome — do not add them.

### Key lint rules (from `.oxlintrc.json`)

- `typescript/no-explicit-any`: **error** — never use `any`
- `no-unused-vars` / `typescript` variants: **error**
- `prefer-const`: **error**
- Correctness rules: **warn** by default, specific rules promoted to **error**

## TypeScript

- Version: `7.x` (see `devDependencies`)
- Root config: `tsconfig.json` — `strict: true` plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`
- `module`/`moduleResolution`: `nodenext`; `target`: `ESNext`
- `verbatimModuleSyntax: true` — use `import type` for type-only imports
- `noEmit: true` at the root; the build script overrides it via CLI flags
- No `any` — use proper types or generics

## Testing

- Runner: `bun test`
- `bun run test` — run tests with bail on first failure (per package, via `--filter '*'`)
- `bun run test:cov` — runs `bun test --coverage` **once from the root** so every package
  lands in a single `coverage/lcov.info`, then `bun run gen:cov`
- `bun run gen:cov` — `scripts/coverage-report.ts` turns that lcov into
  `coverage/index.html` (per-package breakdown, uncovered line ranges, packages with no
  tests), `coverage/coverage.svg`, and a `coverage-<package>.svg` per package. Zero deps
  — bun emits no branch records, so the report covers lines and functions only.
- The per-package badges live in the root README's generated `Packages` table (the
  `Coverage` column added by `scripts/update-readme.ts`), not in the individual package
  READMEs. A package with no test files gets a grey `no tests` badge rather than a
  misleading 0%. New packages pick up a badge automatically on the next `gen:cov` +
  `gen:readme`.
- Pages must be set to the **GitHub Actions** source in repo settings. On the default
  "Deploy from a branch" source, GitHub serves a Jekyll render of the README instead and
  every badge URL 404s.
- `ci.yml` publishes `coverage/` to GitHub Pages from a separate `pages` job on main:
  <https://petarzarkov.github.io/dunx>
- `bunfig.toml` ignores `**/dist/**` for coverage: a package importing a sibling resolves
  to that sibling's `dist/`, which would otherwise be counted alongside its `src/`.

## Typecheck

```bash
bun run typecheck     # all packages: bun run --filter '*' typecheck
```

Within a package: `tsc --noEmit`. The root `tsconfig.json` includes `scripts/`,
so `bunx tsc --noEmit` at the repo root typechecks the repo scripts.

## Versioning & Publishing

- Automated via `bun run version` (runs `scripts/version.ts`)
- Uses conventional commits: `feat:` → minor bump, `fix:` → patch, `BREAKING CHANGE` → major
- CI publishes to npm on push to `main` (if version changed)
- Dry-run: `bun run version:dry-run`
- Force publish all: include `[force-publish]` in commit message
- Publishing uses **npm trusted publishing (OIDC)** — no `NPM_TOKEN`. `ci.yml` is the
  only workflow allowed to publish, because each package's trusted publisher on
  npmjs.com is pinned to that one workflow filename. Renaming `ci.yml` breaks publishing.
- The npm CLI is the single sanctioned non-bun tool here, and only in
  `scripts/version.ts`: `bun publish` cannot authenticate via OIDC
  (oven-sh/bun#15601). It runs as `bunx npm@<pinned>` (the `NPM` constant) — bun
  executes npm on its own runtime, so CI needs no `setup-node`. Bump that pin to
  upgrade npm; it must stay >= 11.5.1, and `ubuntu-latest` still ships npm 10.x, so
  the pin is doing real work.
- `npm publish` does not expand `workspace:` ranges, so `version.ts` rewrites them to
  concrete versions around the publish and restores `package.json` afterwards.
- `--provenance` is passed only when `GITHUB_ACTIONS` is set — it errors out anywhere
  else, which would break a local/manual publish.
- Commands other than `npm publish` (`dist-tag`, `deprecate`, …) cannot use the OIDC
  credential and have to be run locally with a personal npm login.
- A package with no versions on npm has no trusted-publisher settings page yet, so its
  **first** publish must be done manually (`npm login && npm publish`) before CI can take
  over.

## Packages Overview

| Package      | Status  | Description                                  |
| ------------ | ------- | -------------------------------------------- |
| `@dunx/core` | Phase 1 | DI container, decorators, modules, lifecycle |

Planned, in roadmap order: `@dunx/http` (Bun.serve adapter), validation via
Standard Schema, `@dunx/testing`, `@dunx/create-app`, `@dunx/openapi`.

## Repo Scripts

- `bun run gen:readme` — regenerates the README Packages table and Project Structure block (`scripts/update-readme.ts`)
- `bun run gen:cov` — rebuilds the coverage report and badges (`scripts/coverage-report.ts`)
- `bun run version:dry-run` — previews version bumps without writing

## Do Not

- Do not use `npx`, `npm`, `yarn`, or `pnpm` — use `bun`/`bunx`. The one exception is the
  publish path in `scripts/version.ts`, which needs the npm CLI for OIDC trusted
  publishing — and even there it goes through `bunx npm@<pinned>`
- Do not add `experimentalDecorators`, `emitDecoratorMetadata`, `reflect-metadata`, or `tsyringe`
- Do not add CommonJS output or a second/third tsconfig per package
- Do not write a JavaScript router — `Bun.serve({ routes })` handles params, per-method
  dispatch, and method-miss 404s natively
- Do not exceed 500 lines per source file
- Do not add Biome or ESLint
- Do not use `any` — TypeScript strict mode is enforced
- Do not create files unless necessary — prefer editing existing ones
- Do not add docstrings/comments unless logic is non-obvious
- Do not add error handling for impossible scenarios
- Do not add speculative abstractions or future-proofing
- Do not use section-divider comments (e.g. `// ─── Section ───`, `// --- Section ---`, `// === Section ===`) — if a file needs sections, split it into separate files instead

## Do

- When a bug/issue/BC is reported - write a test that reproduces the issue, then do the fix and rerun the test to verify it's been addressed
