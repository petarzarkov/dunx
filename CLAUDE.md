# dunx — Claude Code Instructions

dunx is a Bun-native dependency injection framework. Read
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) before making design decisions —
it records what was measured, what was rejected, and why. Read
[docs/ROADMAP.md](./docs/ROADMAP.md) for what is next, what is still open, and the
reference implementations in `nestjs-template` to work from instead of designing
from scratch.

## Rule 1 — native implementations only

**This rule outranks every other consideration in this file.** If satisfying it
and satisfying something else below are in conflict, this one wins, and the
conflict is worth raising rather than resolving quietly.

Every capability dunx ships must be built on a **Bun-native API** or, failing
that, a **native low-level implementation** — compiled, not JavaScript
reimplementations of things the platform already does. `oxc-parser` in
`@dunx/compiler` is the reference precedent: a Rust parser via N-API, chosen over
a JavaScript AST library.

There are two halves to this, and they pull in opposite directions on purpose.

### Never reimplement what Bun already does

If Bun ships it, use Bun. A JavaScript reimplementation of a platform primitive is
slower, larger, and a maintenance liability. In order of preference:

1. **A `Bun.*` API or `bun:*` module** — `Bun.serve`, `Bun.SQL`, `bun:sqlite`,
   `Bun.RedisClient`, `Bun.file`, `Bun.Image`, `Bun.Glob`, `Bun.password`,
   `Bun.CryptoHasher`, `Bun.color`, `Bun.enableANSIColors`, `Bun.S3Client`.
   See [docs/bun-apis.md](./docs/bun-apis.md).
2. **A Web standard Bun implements natively** — `Request`, `Response`, `Blob`,
   `URL`, `WebSocket`, `ReadableStream`, `crypto.subtle`, `AsyncLocalStorage`.
3. **A native module via N-API**, like `oxc-parser`. Needs a note in
   ARCHITECTURE.md saying which Bun API was missing.

Banned because Bun already does the job: `express`, `ws`, `socket.io`, `ioredis`,
`pg`, `mysql2`, `better-sqlite3`, `postgres.js`, `sharp`, `jimp`, `image-size`,
`glob`, `chokidar`, `axios`, `node-fetch`, `bcrypt`, `dotenv`, `@aws-sdk/*`,
`lodash`.

### Never invent what a mature library already solves

The other failure mode is worse: hand-rolling an ORM, a validator, an auth system
or a job queue. Those are years of edge cases, and a half-built one is a liability
dressed as a feature. Where Bun ships **no** primitive for a hard problem, dunx
**integrates the best-in-class library** rather than competing with it.

The rule for those:

- They go in **`peerDependencies`** (with `peerDependenciesMeta.optional` where the
  feature is opt-in), **never `dependencies`**. The consumer installs and owns the
  version; dunx does not bundle it.
- Where the library offers a **Bun-native driver, that driver is mandatory** —
  `drizzle-orm/bun-sqlite` and `drizzle-orm/bun-sql`, not `pg` or `better-sqlite3`.
  This is how both halves hold at once: the library owns the abstraction, Bun owns
  the I/O.
- dunx's own contract stays **library-agnostic where a standard exists** — route
  validation targets Standard Schema (an interface, zero cost), so Zod, Valibot and
  ArkType all work; zod-specific APIs (`z.toJSONSchema`) sit behind a vendor check.
- Sanctioned integrations: **zod** (validation), **drizzle-orm** (ORM, migrations —
  the default database driver), **better-auth** (authentication), **bullmq**
  (queues). Adding another is a design decision worth recording here.

Do not write a dunx ORM, a dunx validator, a dunx auth flow, or a dunx job queue.

### Reuse the `@arkv` workspace — and extend it upstream

The repo owner maintains `@arkv/*` at `/home/petarzarkov/repos/arkv`, all published
to npm. **Do not reimplement what they already do**, and do not fork them into dunx:

| Need                                         | Use                                      | Never                                                      |
| -------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| Timezones, any date/zone handling            | **`@arkv/timezones`**                    | a hand-rolled zone table, `moment-timezone`, `date-fns-tz` |
| Structured logging, async context, redaction | **`@arkv/logger`** (with `@arkv/colors`) | a second logger in dunx, `pino`, `winston`                 |
| Random numbers, ids, sampling                | **`@arkv/rng`**                          | `Math.random` for anything that matters, `nanoid`, `uuid`  |

`@arkv` is **not Bun-only** — it targets Node.js and the web, and ships ESM + CJS +
types. So a fix that travels upstream must use no `Bun.*` API and must survive the
CommonJS build: no top-level `await`, no `import.meta`. A Bun-specific improvement
(say, one built on `Bun.color`) stays on the dunx side of the boundary and is not an
upstream candidate. arkv also permits TS `enum`, which dunx bans — do not "fix" that
upstream, it is a breaking type change for every arkv consumer.

**Improvements go into the `@arkv` repo, not into dunx.** If dunx needs the logger to
do something it does not do, add it at
`/home/petarzarkov/repos/arkv/packages/logger`, publish, and bump the dependency
here. A local patch, wrapper-with-extra-behaviour, or vendored copy is the wrong
answer — it forks a package the owner maintains and the fix stops reaching his other
projects.

These are `dependencies` (not peer): they are first-party, published, and each has
zero or near-zero transitive weight.

### Where the two halves collide: a library's own engine

`bullmq` depends on **`ioredis`**, which the first half bans because
`Bun.RedisClient` exists. It is not swappable — bullmq uses ioredis-specific Lua
scripting and cluster support.

The ban is on **dunx** reimplementing a Bun primitive, not on a sanctioned
integration's internal engine. `ioredis` arrives transitively as bullmq's engine, a
choice bullmq made; it is not a client dunx picked over Bun's. So:

- **dunx code never imports `ioredis`.** `@dunx/infra/redis` is `Bun.RedisClient`
  and stays that way. An app gets both — Bun's client for its own Redis work,
  bullmq's for the queue internals.
- The alternative was writing a distributed queue with retries, backoff, priorities,
  rate limiting and cron on top of `Bun.RedisClient`. That is the "invent what a
  mature library already solves" failure, and it is the worse one.

If a future integration's engine duplicates a Bun API that dunx _does_ expose
directly, weigh it the same way and record the answer here.

`docs/bun-apis.md` is not exhaustive — Bun ships undocumented APIs, and several
documented ones misbehave. **Probe the runtime before concluding anything**, and
record what you verify there.

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
examples/playground/    # The one example app. Not one per package — see ARCHITECTURE.md
tools/<name>/           # Private workspace tooling, never published
docs/                   # Architecture and design docs
scripts/                # Repo-level scripts (bun-native TS)
.github/workflows/      # CI (ci.yml)
```

Package scope: `@dunx/<name>`. Every package is **ESM only** and emits a single
`dist/` containing JS plus `.d.ts`.

`tools/*` are workspaces but **`"private": true` and never published** — the docs
site and, later, the benchmark harness. They may depend on anything they like; Rule 1
governs what dunx _ships_, not what builds its website.

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

| Package          | Contains                                                                                      |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `@dunx/core`     | DI container, modules, lifecycle, the `Logger` contract                                       |
| `@dunx/compiler` | Load-time constructor-dependency transform (only native dep)                                  |
| `@dunx/http`     | Bun.serve adapter, controllers, **websocket gateways**, middleware, CORS, validation          |
| `@dunx/infra`    | Subpaths `/db` `/redis` `/files` `/images` `/logger`                                          |
| `@dunx/openapi`  | OpenAPI 3.1 from the routes' own zod schemas, self-contained HTML (zod is a `peerDependency`) |

Five packages, deliberately few. Merging is nearly free because the runtime weight is
almost nil — `@dunx/core` has **zero dependencies**, and ESM tree-shaking drops what
is not imported. `@dunx/compiler` stays separate because it is the only package with a
native dependency (`oxc-parser`) and is build-time only; merging it would put a Rust
parser in every production deploy.

Two areas of `@dunx/infra` are integrations rather than dunx code, per Rule 1's second
half: `/db` is **drizzle** over `drizzle-orm/bun-sqlite` and `drizzle-orm/bun-sql`
(`drizzle-orm` is an optional `peerDependency`), and `/logger` binds **`@arkv/logger`**
to core's `Logger` contract (a `dependency`, since `@arkv` is first-party). Neither
restates the library's own surface — see `packages/infra/README.md`.

Planned, in roadmap order: validation via Standard Schema, `@dunx/testing`,
`@dunx/create-app`, `@dunx/openapi`.

There is **one** example app, `examples/playground`, which CI boots and which grows
through the phases. Per-package examples were tried and reverted — see
docs/ARCHITECTURE.md, Phase 1. A part needing an absent service (Redis, Postgres, S3)
prints that it is skipping and the app still exits 0.

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
