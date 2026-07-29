# dunx — Claude Code Instructions

dunx is a Bun-native dependency injection framework. Read
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) before making design decisions —
it records what was measured, what was rejected, and why.

## Rule 1 — native implementations only

**This rule outranks every other consideration in this file.** If satisfying it
and satisfying something else below are in conflict, this one wins, and the
conflict is worth raising rather than resolving quietly.

Every capability dunx ships must be built on a **Bun-native API** or, failing
that, a **native low-level implementation** — compiled, not JavaScript
reimplementations of things the platform already does. `oxc-parser` in
`@dunx/compiler` is the reference precedent: a Rust parser via N-API, chosen over
a JavaScript AST library.

In order of preference:

1. **A `Bun.*` API or `bun:*` module.** `Bun.serve`, `Bun.SQL`, `bun:sqlite`,
   `Bun.RedisClient`, `Bun.file`, `Bun.Image`, `Bun.Glob`, `Bun.password`,
   `Bun.CryptoHasher`, `Bun.zstdCompress`. See [docs/bun-apis.md](./docs/bun-apis.md).
2. **A Web standard Bun implements natively** — `Request`, `Response`, `Blob`,
   `URL`, `WebSocket`, `ReadableStream`, `crypto.subtle`.
3. **A native module via N-API**, like `oxc-parser`. Requires a note in
   ARCHITECTURE.md saying what Bun API was missing.
4. Nothing else.

Concretely banned: `express`, `ws`, `ioredis`, `pg`, `mysql2`, `better-sqlite3`,
`sharp`, `jimp`, `axios`, `node-fetch`, `glob`, `chokidar`, `bcrypt`, `dotenv`,
`lodash`, and any JavaScript reimplementation of a `Bun.*` API.

`docs/bun-apis.md` is not exhaustive — Bun ships undocumented APIs. **Probe the
runtime before concluding something is unavailable**, and extend that file with
what you verify.

### The one sanctioned exception: validation

Bun ships no schema API, so validation cannot satisfy the ladder above. The
resolution is that **dunx never depends on a validator**:

- The framework's contract is **Standard Schema** — an _interface_, restated in
  `packages/http/src/route/schema.ts` at zero dependency cost. Zod 4, Valibot and
  ArkType all satisfy it, so any of them works.
- Where a **zod-specific** API is genuinely needed — `z.toJSONSchema` and `.meta()`
  for OpenAPI generation — zod is a **`peerDependency`**, never a `dependency`. The
  consumer installs it; dunx does not bundle it.

Adding a validator to any package's `dependencies` is a Rule 1 violation.

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
  proposal, so `@Inject()` does not exist and never will.
- Do not add `reflect-metadata` or `tsyringe`.

## Dependency injection

Constructor injection is the default and needs no annotation of any kind:

```ts
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}
}
```

`@dunx/compiler` reads each class's constructor parameter types at load time and
records them on the class as a thunk under `Symbol.for('dunx.deps')`; the
container resolves them before calling `new`. Apps opt in with one line:

```toml
preload = ["@dunx/compiler/preload"]
```

Consequences to keep in mind when changing this area:

- A parameter whose type is erased — an interface, a primitive, a union, a
  type-only import, a class type parameter — is recorded as `unresolved` and
  becomes a **boot error naming that parameter**, not a silent `undefined`. This
  is the wart `emitDecoratorMetadata` has and dunx does not.
- A class with constructor parameters but **no** record means the plugin never ran.
  The container detects that via `ctor.length` and fails at boot with the preload
  snippet. Do not "fix" that by making core register the plugin on import — it
  would make DI import-order dependent and pull a native parser into core. The
  reasoning is in docs/ARCHITECTURE.md, "Why `@dunx/core` does not register it
  itself".
- The record is a **thunk**, evaluated at resolution rather than class-definition
  time. That is what makes a dependency declared later in the file, or across a
  circular import, work without `forwardRef`.
- `readDeps` uses prototype-chain lookup on purpose: a subclass with no
  constructor of its own inherits the base's constructor and must inherit its
  dependencies with it.
- `inject()` in a field initializer still works and is still the escape hatch for
  a value with no constructor parameter to hang off. Both may be used in one class.
- The transform only touches **class declarations**. A class expression's own name
  is not in scope outside it, so appending a statement there would be a
  `ReferenceError`.

See docs/ARCHITECTURE.md for the measurements behind all of this.

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
- Repo-local rules live in `scripts/oxlint-plugin.ts`, wired via `jsPlugins`. oxlint
  has no `no-restricted-syntax`, so anything syntax-shaped goes there. Currently:
  `dunx/no-enum` and `dunx/no-brand-prefix`.
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
- `bun run test:cov` — one root run over `./packages ./scripts` so everything lands in
  a single `coverage/lcov.info`, then `bun run gen:cov`. It deliberately excludes
  `examples/`: the root has no compiler preload, because core's missing-transform
  test asserts that un-transformed state. Example tests run per workspace, where the
  per-example `bunfig.toml` supplies the preload.
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

| Package          | Contains                                                                             |
| ---------------- | ------------------------------------------------------------------------------------ |
| `@dunx/core`     | DI container, modules, lifecycle                                                     |
| `@dunx/compiler` | Load-time constructor-dependency transform (only native dep)                         |
| `@dunx/http`     | Bun.serve adapter, controllers, **websocket gateways**, middleware, CORS, validation |
| `@dunx/infra`    | Subpaths `/db` `/redis` `/files` `/images` over Bun built-ins                        |

Four packages, deliberately. Merging is nearly free because every one of these has
**zero dependencies** except `@dunx/core` — there is no transitive weight to inherit
and ESM tree-shaking drops what is not imported. `@dunx/compiler` stays separate
because it is the only package with a native dependency (`oxc-parser`) and is
build-time only; merging it would put a Rust parser in every production deploy.

Planned, in roadmap order: validation via Standard Schema, `@dunx/testing`,
`@dunx/create-app`, `@dunx/openapi`.

Every package has a matching `examples/<name>` app that CI boots. One needing an
absent service (Redis, Postgres, S3) prints that it is skipping and still exits 0.

## Repo Scripts

- `bun run gen:readme` — regenerates the README Packages table and Project Structure block (`scripts/update-readme.ts`)
- `bun run gen:cov` — rebuilds the coverage report and badges (`scripts/coverage-report.ts`)
- `bun run version:dry-run` — previews version bumps without writing

## Skills

Multi-step workflows live in `.claude/skills/`, not here. Only their names and
descriptions are in context until one is invoked, so this file stays cheap.

| Skill              | Invoke when                                                         |
| ------------------ | ------------------------------------------------------------------- |
| `/whats-next`      | Ending a task block, crossing ~50% context, handing off, resuming   |
| `/ci-check`        | Verifying build + lint + typecheck + test before a commit           |
| `/spike`           | An open question needs measuring on real Bun before an API is fixed |
| `/new-package`     | Adding a package, an example, or a public subpath export            |
| `/release`         | Cutting a release, or a publish failed                              |
| `/coverage-report` | Coverage numbers or badges are wrong                                |

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
- Do not prefix identifiers with `Dunx` — the brand belongs in the package name,
  not in every symbol. Use `App`: `AppFactory`, `AppError`, `AppModule`. Enforced
  by `dunx/no-brand-prefix` in `scripts/oxlint-plugin.ts`
- Do not use `any` — TypeScript strict mode is enforced
- Do not write `enum` (or `const enum`) — `dunx/no-enum` rejects it. An enum is the
  one TS construct that cannot be erased: it emits a runtime object with reverse
  mappings. Use a frozen object plus an indexed-access union, exporting one name for
  both the value and the type:

  ```ts
  export const HttpStatusCode = Object.freeze({
    OK: 200,
    NOT_FOUND: 404,
  } as const);
  export type HttpStatusCode =
    (typeof HttpStatusCode)[keyof typeof HttpStatusCode];
  ```

  `as const` gives the literal types, `Object.freeze` gives the runtime
  immutability an `as const` object alone does not have. Add
  `keyof typeof X` as a second type when the names are needed too.

- Do not create files unless necessary — prefer editing existing ones
- Do not add docstrings/comments unless logic is non-obvious
- Do not add error handling for impossible scenarios
- Do not add speculative abstractions or future-proofing
- Do not document a multi-step workflow in this file — add a skill under
  `.claude/skills/` so it costs nothing until it is invoked
- Do not use section-divider comments (e.g. `// ─── Section ───`, `// --- Section ---`, `// === Section ===`) — if a file needs sections, split it into separate files instead

## Do

- When a bug/issue/BC is reported - write a test that reproduces the issue, then do the fix and rerun the test to verify it's been addressed
