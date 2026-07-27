# dunx — Claude Code Instructions

## Runtime & Package Manager

- **Bun** is the only runtime and package manager. Never use `npm`, `npx`, `yarn`, or `pnpm`.
- Run packages/tools with `bunx` (e.g. `bunx oxlint`).
- Run scripts with `bun run <script>`.
- Execute TypeScript files directly with `bun <file.ts>`.
- Install dependencies with `bun install` (use `--frozen-lockfile` in CI).
- Refer to [./bun-apis.md](./bun-apis.md)for Bun APIs usage

## Monorepo Structure

```
packages/<name>/        # Each published package
  src/                  # Source TypeScript
  dist/                 # Build output (gitignored)
  package.json
  tsconfig.json         # Extends ../../tsconfig.json
  tsconfig.build.esm.json
  tsconfig.build.cjs.json
  tsconfig.build.types.json
scripts/                # Repo-level scripts (bun-native TS)
.github/workflows/      # CI (ci.yml)
```

Package scope: `@dunx/<name>`. Each package produces three outputs: ESM (`dist/esm/`), CJS (`dist/cjs/`), and Types (`dist/types/`).

## Linting & Formatting

- **Linter**: `oxlint` (config: `.oxlintrc.json` at repo root)
- **Formatter**: `oxfmt` (no config file — uses defaults)
- Run lint: `bun run lint` → `oxlint --fix .`
- Run format: `bun run format` → `oxfmt --write .`
- Pre-commit hook runs lint-staged: lints then formats staged `.ts` files.
- There is no ESLint or Biome — do not add them.

### Key lint rules (from `.oxlintrc.json`)

- `typescript/no-explicit-any`: **error** — never use `any`
- `no-unused-vars` / `typescript` variants: **error**
- `prefer-const`: **error**
- Correctness rules: **warn** by default, specific rules promoted to **error**

## TypeScript

- Version: `6.x` (see `devDependencies`)
- Root config: `tsconfig.json` — `strict: true`, `noImplicitAny`, `noUnusedLocals`, `noUnusedParameters`
- `moduleResolution: "bundler"`, `module: "ESNext"`, `target: "ESNext"`
- `emitDecoratorMetadata` and `experimentalDecorators` are enabled (NestJS support)
- No `any` — use proper types or generics
- Prefer `type` imports where possible (especially in `nestjs-context-logger`)

## Building

Each package build is triggered via:

```bash
bun run build         # all packages: bun run --filter '*' build
```

Within a package:

```bash
bun run build:esm     # tsc -p tsconfig.build.esm.json
bun run build:cjs     # tsc -p tsconfig.build.cjs.json
bun run build:types   # tsc -p tsconfig.build.types.json
# All three run in parallel via bun run --parallel
```

`prebuild` removes `dist/`, `postbuild` writes `{"type":"commonjs"}` into `dist/cjs/package.json` and `{"type":"module"}` into `dist/esm/package.json`.

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

Within a package: `tsc --noEmit`

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

| Package                       | Description                                         |
| ----------------------------- | --------------------------------------------------- |
| `@dunx/colors`                | Zero-dep ANSI color utilities                       |
| `@dunx/shared`                | Array, async, number, object, string, url utilities |
| `@dunx/logger`                | Structured logger (depends on colors + shared)      |
| `@dunx/rng`                   | RNG with Rust/WASM (`bun run build:wasm` step)      |
| `@dunx/timezones`             | Generated IANA tzdb data + lookup helpers           |
| `@dunx/nestjs-context-logger` | NestJS DI wrapper around `@dunx/logger`             |

### @dunx/rng notes

- First-time setup requires Rust toolchain + wasm-pack: run `packages/rng/setup.sh`
- Build order: `build:wasm` (Rust→WASM) runs first, then TS compilation (`build:ts`)
- `bun run build` at package level handles this sequence automatically

### @dunx/timezones notes

- `src/timezones.ts` is **generated** — never hand-edit. It is excluded from oxlint and
  oxfmt (`timezones.ts` in both ignore lists) because it is one ~150KB line.
- Regenerate with `bun run --filter '@dunx/timezones' generate`; `FORCE_REVALIDATE=true`
  skips the `If-Modified-Since` check against `previous.json`.
- `scripts/` holds the generator (build-time only, excluded from the tsc build outputs);
  `src/` holds only what ships. Generator-only types live in `scripts/types.ts`.
- `.github/workflows/tzdb.yml` refreshes the data weekly, commits it, then dispatches
  `ci.yml` — a `GITHUB_TOKEN` push cannot trigger a workflow on its own.
- Zone `utc`/`label` are snapshots from generation time, not live offsets.

### @dunx/nestjs-context-logger notes

- `// oxlint-disable-next-line <rule>` syntax for inline disable (no Biome)
- `useImportType` lint rule is off for this package (configured in `.oxlintrc.json`)

## Repo Scripts

- `bun run gen:readme` — regenerates root README from package metadata (`scripts/update-readme.ts`)
- `bun run gen:env:docs` — regenerates env variable docs (`scripts/gen-env-docs.ts`)
- `bun run version:dry-run` — previews version bumps without writing

## Do Not

- Do not use `npx`, `npm`, `yarn`, or `pnpm` — use `bun`/`bunx`. The one exception is the
  publish path in `scripts/version.ts`, which needs the npm CLI for OIDC trusted
  publishing — and even there it goes through `bunx npm@<pinned>`
- Do not exceed 500 lines per source file — except the generated
  `packages/timezones/src/timezones.ts`
- Do not add Biome or ESLint
- Do not use `any` — TypeScript strict mode is enforced
- Do not create files unless necessary — prefer editing existing ones
- Do not add docstrings/comments unless logic is non-obvious
- Do not add error handling for impossible scenarios
- Do not add speculative abstractions or future-proofing
- Do not use section-divider comments (e.g. `// ─── Section ───`, `// --- Section ---`, `// === Section ===`) — if a file needs sections, split it into separate files instead

## Do

- When a bug/issue/BC is reported - write a test that reproduces the issue, then do the fix and rerun the test to verify it's been addressed
