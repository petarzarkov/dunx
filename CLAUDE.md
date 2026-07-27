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

Within a package, `build` is `bun ../../scripts/build-package.ts` — one
implementation for every package. It derives entrypoints from the manifest's
`exports` and `bin` fields, so a new public subpath cannot be added without also
being built. `Bun.build` emits the JS, `tsc --emitDeclarationOnly` the `.d.ts`
(Bun has no `--dts`). Use `/new-package` when adding a package or an export.

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
- Correctness rules are **warn** by default; `.oxlintrc.json` promotes
  `typescript/no-explicit-any`, `no-unused-vars`, and `prefer-const` to **error**.

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
- Coverage report, badges, and the GitHub Pages site: `/coverage-report`

## Typecheck

```bash
bun run typecheck     # all packages: bun run --filter '*' typecheck
```

Within a package: `tsc --noEmit`. The root `tsconfig.json` includes `scripts/`,
so `bunx tsc --noEmit` at the repo root typechecks the repo scripts.

## Versioning & Publishing

CI runs `bun run version` on every push to `main` and publishes any package whose
version changed, via npm trusted publishing (OIDC). Conventional commits drive the
bump. Nothing to run by hand.

Everything else — the OIDC constraints, the `ci.yml` filename pin, the npm version
pin, `workspace:` rewriting, first-publish-must-be-manual: `/release`.

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

## Skills

Multi-step workflows live in `.claude/skills/`, not here. Only their names and
descriptions are in context until one is invoked, so this file stays cheap.

| Skill              | Invoke when                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `/whats-next`      | Ending a task block, crossing ~50% context, handing off, resuming    |
| `/ci-check`        | Verifying build + lint + typecheck + test before a commit            |
| `/spike`           | An open question needs measuring on real Bun before an API is fixed  |
| `/new-package`     | Adding a package, an example, or a public subpath export             |
| `/release`         | Cutting a release, or a publish failed                               |
| `/coverage-report` | Coverage numbers or badges are wrong                                 |

New repeatable workflow → new skill. Do not grow this file instead.

## Context Discipline

- Check load with `/context`. Past ~50% both reasoning and retrieval degrade —
  treat it as the line to act on, not a budget to spend.
- `/whats-next` before `/compact` or `/clear`, so state survives in `HANDOFF.md`
  rather than in a summary you did not control. `/compact` with explicit
  preservation instructions; `/clear` when switching subtask outright. Resume with
  `continue from HANDOFF.md`.
- **Delegate wide reads.** Exploratory sweeps across packages, full test or CI log
  analysis, and probe iteration go to a subagent (`Explore` for locating code,
  `general-purpose` for multi-step work). Ask for a verdict plus `file:line`, not
  file contents — the raw data stays in their window.
- Keep `mcp.json` minimal. Every configured server's full tool schema loads at
  startup whether or not it is used.

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
- Do not document a multi-step workflow in this file — add a skill under
  `.claude/skills/` so it costs nothing until it is invoked
- Do not use section-divider comments (e.g. `// ─── Section ───`, `// --- Section ---`, `// === Section ===`) — if a file needs sections, split it into separate files instead

## Do

- When a bug/issue/BC is reported - write a test that reproduces the issue, then do the fix and rerun the test to verify it's been addressed
