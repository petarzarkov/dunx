# dunx - Claude Code Instructions

dunx is a Bun-native dependency injection framework. Read
[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) before making design decisions -
it records what was measured, what was rejected, and why. Read
[docs/ROADMAP.md](./docs/ROADMAP.md) for what is next, what is still open, and the
reference implementations in `nestjs-template` to work from instead of designing
from scratch.

## Rule 1 - native implementations only

**This rule outranks every other consideration in this file.** If satisfying it
and satisfying something else below are in conflict, this one wins, and the
conflict is worth raising rather than resolving quietly.

Every capability dunx ships must be built on a **Bun-native API** or, failing
that, a **native low-level implementation** - compiled, not JavaScript
reimplementations of things the platform already does. `oxc-parser` in
`@dunx/transform` is the reference precedent: a Rust parser via N-API, chosen over
a JavaScript AST library.

There are two halves to this, and they pull in opposite directions on purpose.

### Never reimplement what Bun already does

If Bun ships it, use Bun. A JavaScript reimplementation of a platform primitive is
slower, larger, and a maintenance liability. In order of preference:

1. **A `Bun.*` API or `bun:*` module** - `Bun.serve`, `Bun.SQL`, `bun:sqlite`,
   `Bun.RedisClient`, `Bun.file`, `Bun.Image`, `Bun.Glob`, `Bun.password`,
   `Bun.CryptoHasher`, `Bun.color`, `Bun.enableANSIColors`, `Bun.S3Client`.
   See [docs/bun-apis.md](./docs/bun-apis.md).
2. **A Web standard Bun implements natively** - `Request`, `Response`, `Blob`,
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
- Where the library offers a **Bun-native driver, that driver is mandatory** -
  `drizzle-orm/bun-sqlite` and `drizzle-orm/bun-sql`, not `pg` or `better-sqlite3`.
  This is how both halves hold at once: the library owns the abstraction, Bun owns
  the I/O.
- dunx's own contract stays **library-agnostic where a standard exists** - route
  validation targets Standard Schema (an interface, zero cost), so Zod, Valibot and
  ArkType all work; zod-specific APIs (`z.toJSONSchema`) sit behind a vendor check.
- Sanctioned integrations: **zod** (validation), **drizzle-orm** (ORM, migrations -
  the default database driver), **better-auth** (authentication), **bullmq**
  (queues). Adding another is a design decision worth recording here.

Do not write a dunx ORM, a dunx validator, a dunx auth flow, or a dunx job queue.

### Reuse the `@arkv` workspace - and extend it upstream

The repo owner maintains `@arkv/*` at `~/repos/arkv`, all published
to npm. **Do not reimplement what they already do**, and do not fork them into dunx:

| Need                                         | Use                                      | Never                                                      |
| -------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| Timezones, any date/zone handling            | **`@arkv/timezones`**                    | a hand-rolled zone table, `moment-timezone`, `date-fns-tz` |
| Structured logging, async context, redaction | **`@arkv/logger`** (with `@arkv/colors`) | a second logger in dunx, `pino`, `winston`                 |
| Random numbers, ids, sampling                | **`@arkv/rng`**                          | `Math.random` for anything that matters, `nanoid`, `uuid`  |

`@arkv` is **not Bun-only** - it targets Node.js and the web, and ships ESM + CJS +
types. So a fix that travels upstream must use no `Bun.*` API and must survive the
CommonJS build: no top-level `await`, no `import.meta`. A Bun-specific improvement
(say, one built on `Bun.color`) stays on the dunx side of the boundary and is not an
upstream candidate. arkv also permits TS `enum`, which dunx bans - do not "fix" that
upstream, it is a breaking type change for every arkv consumer.

**Improvements go into the `@arkv` repo, not into dunx.** If dunx needs the logger to
do something it does not do, add it at
`~/repos/arkv/packages/logger`, publish, and bump the dependency
here. A local patch, wrapper-with-extra-behaviour, or vendored copy is the wrong
answer - it forks a package the owner maintains and the fix stops reaching his other
projects.

These are `dependencies` (not peer): they are first-party, published, and each has
zero or near-zero transitive weight.

### Where the two halves collide: a library's own engine

`bullmq` depends on **`ioredis`**, which the first half bans because
`Bun.RedisClient` exists.

**This resolved better than the paragraph that used to sit here predicted, and it
was resolved by measuring.** bullmq 6 ships `createBunRedisClient`, an
`IRedisClient` adapter over `Bun.RedisClient`, and `@dunx/infra/queue` uses it - so
every byte of queue traffic goes through Bun's client and `dist/` contains no
reference to ioredis. `ioredis` must still be _installed_, because bullmq 6.0.5's
barrel imports it statically despite documenting it as optional (measured, recorded
in docs/architecture/queues.md), so it is an optional peer.

The general rule stands, and is what let the better answer be found:

- **dunx code never imports `ioredis`.** `@dunx/infra/redis` is `Bun.RedisClient`
  and stays that way.
- The ban is on **dunx** reimplementing a Bun primitive, not on a sanctioned
  integration's internal engine. Had bullmq offered no Bun adapter, its own engine
  would have been acceptable - because the alternative was writing a distributed
  queue with retries, backoff, priorities, rate limiting and cron on top of
  `Bun.RedisClient`, which is the "invent what a mature library already solves"
  failure and the worse one.

If a future integration's engine duplicates a Bun API that dunx _does_ expose
directly, weigh it the same way - and **check whether the library already has a Bun
adapter before assuming it does not.**

`docs/bun-apis.md` is not exhaustive - Bun ships undocumented APIs, and several
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
  tsconfig.json         # Extends ../../tsconfig.json - one per package, no build variants
examples/<name>/        # minimal, databases, testing, full - a ladder, not one per package
tools/<name>/           # Private workspace tooling, never published
docs/                   # Architecture and design docs
scripts/                # Repo-level scripts (bun-native TS)
.github/workflows/      # CI (ci.yml)
```

Package scope: `@dunx/<name>`. Every package is **ESM only** and emits a single
`dist/` containing JS plus `.d.ts`.

`tools/*` are workspaces but **`"private": true` and never published** - the docs
site, the benchmark harness and the API explorer, all built. They may depend on
anything they like; Rule 1 governs what dunx _ships_, not what builds its website
or measures it. That is why `tools/bench` may devDepend on express and fastify,
which Rule 1 bans everywhere else.

`tools/docs` builds with **Vite**, and used to build with `Bun.build`. The original
decision bought build speed - 41 ms against Vite 5's 1.7 s - and paid ~25% more
gzipped JS for it. **Both halves of that stopped being true and it was reversed
by re-measuring**: Vite 8 is Rolldown, so the same site builds in ~0.30 s against
`Bun.build`'s ~0.15 s, a difference that means nothing in CI, while tree shaking
puts the gzipped JS at 416.9 KB against 506.5 KB. Re-measure before reversing it
again; the numbers are in architecture/tooling.md, "Documentation site".

`tools/openapi-ui` **does** use Vite, for the opposite reason: its bundle is
inlined byte-for-byte into the page `@dunx/openapi` serves, so Rollup's
tree-shaking earns its 1.8 s. Its build writes `packages/openapi/src/ui-bundle.ts` generated, committed, and regenerated by `packages/openapi`'s own `build` so it
cannot go stale. Read `tools/openapi-ui/README.md` before touching it; every
component added costs bytes twice, in JS and in the CSS list in `src/styles.ts`.

That bundle is behind the **`@dunx/openapi/ui`** subpath and reached with
`await import()` from `OpenApiExplorer.page()`, so importing `@dunx/openapi` does
not load it. `html.ts` takes the script to inline as an argument (`renderShell`)
and must not import `ui-bundle.ts`, or the split silently reverts.

## Decorators - standard only

- The root tsconfig deliberately does **not** set `experimentalDecorators` or
  `emitDecoratorMetadata`. Do not add them.
- Use TC39 standard decorators. There are no parameter decorators in that
  proposal, so `@Inject()` does not exist and never will.
- Do not add `reflect-metadata` or `tsyringe`.
- **One carve-out, and it proves the rule rather than bending it:**
  `tools/bench/servers/nest/` sets both flags and imports `reflect-metadata`,
  because the NestJS benchmark subject has to run NestJS's actual programming
  model - measuring a fake Nest would measure nothing. It has its own
  `tsconfig.json`, it is excluded from every other project, and the subject
  registry reaches it by string path so no compiler ever crosses the boundary.
  Nothing else may use them, and dunx itself still never needs them.

## Dependency injection

Constructor injection is the default and needs no annotation of any kind:

```ts
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}
}
```

`@dunx/transform` reads each class's constructor parameter types at load time and
records them on the class as a thunk under `Symbol.for('dunx.deps')`; the
container resolves them before calling `new`. Apps opt in with one line:

```toml
preload = ["@dunx/transform/preload"]
```

Consequences to keep in mind when changing this area:

- A parameter whose type is erased - an interface, a primitive, a union, a
  type-only import, a class type parameter - is recorded as `unresolved` and
  becomes a **boot error naming that parameter**, not a silent `undefined`. This
  is the wart `emitDecoratorMetadata` has and dunx does not.
- A class with constructor parameters but **no** record means the plugin never ran.
  The container detects that via `ctor.length` and fails at boot with the preload
  snippet. Do not "fix" that by making core register the plugin on import - it
  would make DI import-order dependent and pull a native parser into core. The
  reasoning is in docs/architecture/dependency-injection.md, "Why `@dunx/core` does not register it
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

## Always-bound contracts

`AppFactory.create` offers a default binding for two tokens **after** every
module's, so a module that binds either one wins:

| Token            | Default               | Replaced by                            |
| ---------------- | --------------------- | -------------------------------------- |
| `Logger`         | `ConsoleLogger`       | `LoggerModule` → `@arkv/logger`        |
| `RequestContext` | `AsyncRequestContext` | `LoggerModule` → arkv's `ContextStore` |

They exist so `@dunx/http` can log every request in an app that imported no
logging module at all. Neither default reaches for a dependency: `ConsoleLogger`
writes one JSON line per entry and `AsyncRequestContext` is `AsyncLocalStorage`,
a Node built-in Bun implements natively. `ConsoleLogger` does **not** sanitize,
mask or rotate - that is what makes swapping in `@dunx/infra/logger` worth it.

`ConsoleLogger` **batches `info` and below into one write per event-loop turn** -
a `write(2)` per entry was the largest single cost in request logging. `warn` and
above are never batched and flush what is queued behind them, `flush()` is public,
and `onShutdown()` calls it. Measurements and the durability trade: ARCHITECTURE.md,
"The cost of request logging".

`RequestContext` is the same trick as `Logger`: an abstract class in core that
`@arkv/logger`'s `ContextStore` satisfies structurally, so the binding is a
`provide` with no adapter between them.

## Configuration

`ConfigModule.forRoot({ validate })` in `@dunx/core`. **One validation function**,
not a schema DSL - it takes the raw env and returns the shaped, typed object, and
whatever it throws is what boot fails with. zod is `validate: (env) => schema.parse(env)`;
a hand-written function works identically and costs no dependency.

Bun already loads `.env` and `.env.local`, so there is no loader and no `dotenv`.
The source defaults to `Bun.env`; pass `source` in a test rather than mutating the
process environment.

Declare a subclass and hand it to `as`, which is what keeps the type through a
factory's `inject: [...]`:

```ts
export class AppConfigService extends ConfigService<AppConfig> {}
ConfigModule.forRoot({ validate, as: AppConfigService });
```

Without it, `inject: [ConfigService]` resolves to `ConfigService<Record<string, unknown>>`
and a factory annotating `ConfigService<AppConfig>` is rejected - parameters are
contravariant and the token carries no type argument to recover.

`forRootAsync({ useFactory, inject })` exists on `LoggerModule`, `ImagesModule`,
`RedisModule`, `FilesModule` and `DbModule` for the same reason: reading options
off `ConfigService` is the one thing a zero-argument `forRoot` function cannot do.

## Request logging

`@dunx/http` installs `RequestLoggingMiddleware` **by default**, outermost in the
chain. `HttpFactory.create(root, { requestLogging: false })` removes it; an options
object tunes it.

**One entry per request**, carrying the request and the response together - Nest
needs a middleware plus an interceptor because they are different classes, and dunx
does not, because middleware wraps `next()`. A 4xx logs at `warn`, a 5xx at `error`.
Do not add a second "received request" line; the pair is the thing being avoided.

An unmatched path is logged too. `Bun.serve({ routes })` answers a miss itself, so
`listen()` installs one `fetch` fallback that puts the global middleware in front of
a `{"error":"NOT_FOUND","status":404}`. That is **not** a JavaScript router - Bun
still does all the matching, and the fallback runs only once it has matched nothing.

## Building

```bash
bun run build         # every workspace, in dependency order (scripts/build-all.ts)
```

Within a package, `build` is `bun ../../scripts/build-package.ts` - one
implementation for every package. It derives entrypoints from the manifest's
`exports` and `bin` fields, so a new public subpath cannot be added without also
being built. `Bun.build` emits the JS, `tsc --emitDeclarationOnly` the `.d.ts`
(Bun has no `--dts`). Use `/new-package` when adding a package or an export.

`splitting` is **on**, and must stay on. With it off `Bun.build` inlines a
relative `await import()` into the importing entry, which would make
`@dunx/openapi`'s `./ui` split a no-op that still shipped 456 KB to every
consumer - measured, in ARCHITECTURE.md. It also stopped multi-entry packages
duplicating a shared module into every subpath.

Relative imports **must** carry a `.js` extension. `tsc` copies the specifier
verbatim into the emitted `.d.ts`, and an extensionless one fails to resolve for
consumers on `node16`/`nodenext`. `moduleResolution: nodenext` in the root
tsconfig makes this a compile error rather than a consumer's problem.

Every package manifest needs `"type": "module"`. Without it,
`verbatimModuleSyntax` raises `TS1287` against ESM syntax.

## Linting & Formatting

- **Linter**: `oxlint` (config: `.oxlintrc.json` at repo root)
- **Formatter**: `oxfmt` (config: `.oxfmtrc.json`)
- Repo-local rules live in `scripts/oxlint-plugin.js`, wired via `jsPlugins`. oxlint
  has no `no-restricted-syntax`, so anything syntax-shaped goes there. Currently:
  `dunx/no-enum` and `dunx/no-brand-prefix`.
- `max-lines` is set to 500 and is an **error**, which is what makes the 500-line
  rule below a gate rather than a convention. It counts every line, comments and
  blanks included, so the number in the config is the number in the docs.
- **That plugin is `.js`, and must stay `.js`.** oxlint loads a JS plugin by
  spawning **Node**, not Bun, so a `.ts` file there dies with
  `ERR_UNKNOWN_FILE_EXTENSION` on any Node below 22.18 - which broke the
  pre-commit hook and left CI depending on the runner image's Node. It is the one
  file in the repo that is deliberately not TypeScript; `@ts-check` plus JSDoc
  keeps it typed.
- `bun run lint` / `bun run format` fix in place; `lint:check` / `format:check`
  do not and are what CI runs.
- Pre-commit hook runs lint-staged: lints then formats staged `.ts` files. Its
  entries are the **bare binaries** (`oxlint --fix`, `oxfmt`), not `bun run lint` /
  `bun run format` - those end in `.`, and lint-staged _appends_ the staged paths, so
  `oxlint --fix . <files>` linted the whole repo on every commit and failed on
  unrelated pre-existing errors.
- **Type-aware lint needs `dist/` built.** `oxlint` resolves a workspace import
  through the package's `types` entry, so an unbuilt or stale `dist/` reads as
  `TS2307: Cannot find module '@dunx/...'` or a missing export, in files nobody
  touched. CI cannot hit this because it builds before linting (`ci.yml`, Build then
  Lint); locally, `bun run build` first. If `lint:check` reports errors only in
  packages you did not edit, that is this - not a real defect.
- There is no ESLint or Biome - do not add them.
- Correctness rules are **warn** by default; `.oxlintrc.json` promotes
  `typescript/no-explicit-any`, `no-unused-vars`, and `prefer-const` to **error**.

## TypeScript

- Version: `7.x` (see `devDependencies`)
- Root config: `tsconfig.json` - `strict: true` plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`
- `module`/`moduleResolution`: `nodenext`; `target`: `ESNext`
- `verbatimModuleSyntax: true` - use `import type` for type-only imports
- `noEmit: true` at the root; the build script overrides it via CLI flags
- No `any` - use proper types or generics

## Testing

- Runner: `bun test`
- `bun run test` - run tests with bail on first failure (per package, via `--filter '*'`)
- `bun run test:cov` - one root run over `./packages ./scripts` (excluding
  `**/templates/**`, which holds a working app whose test cannot resolve from there)
  so everything lands in
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

Everything else - the OIDC constraints, the `ci.yml` filename pin, the npm version
pin, `workspace:` rewriting, first-publish-must-be-manual: `/release`.

## Packages Overview

| Package            | Contains                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `@dunx/core`       | DI container, modules, lifecycle, config, the `Logger`/`RequestContext` contracts                                                |
| `@dunx/transform`  | Load-time constructor-dependency transform (only native dep)                                                                     |
| `@dunx/http`       | Bun.serve adapter, controllers, **websocket gateways**, middleware, CORS, validation; an outbound `HttpClient` behind `./client` |
| `@dunx/infra`      | Subpaths `/db` `/redis` `/queue` `/files` `/images` `/logger` `/pagination`                                                      |
| `@dunx/openapi`    | OpenAPI 3.1 from the routes' own zod schemas; `tools/openapi-ui`'s explorer inlined behind `./ui` (zod is a `peerDependency`)    |
| `@dunx/auth`       | **better-auth** mounted, `SessionGuard`, `AuthContext`, `Bun.password` hashing                                                   |
| `@dunx/testing`    | `createTestApp` / `createTestServer` - overrides replaced in place, real server on port 0                                        |
| `@dunx/create-app` | `bunx @dunx/create-app my-api` - a `base` template plus composable feature folders, with versions resolved at run time           |
| `@dunx/mcp`        | An MCP server over stdio that **reads** an app's routes, providers and modules. Never boots it                                   |

Ten packages, deliberately few. Merging is nearly free because the runtime weight is
almost nil - `@dunx/core` has **zero dependencies**, and ESM tree-shaking drops what
is not imported. `@dunx/transform` stays separate because it is the only package with a
native dependency (`oxc-parser`) and is build-time only; merging it would put a Rust
parser in every production deploy.

Three areas are integrations rather than dunx code, per Rule 1's second half:
`@dunx/infra/db` is **drizzle** over `drizzle-orm/bun-sqlite` and `drizzle-orm/bun-sql`
(`drizzle-orm` is an optional `peerDependency`), `@dunx/infra/logger` binds
**`@arkv/logger`** to core's `Logger` contract (a `dependency`, since `@arkv` is
first-party), `@dunx/auth` is **better-auth** (a required `peerDependency`) - the
module, the mount, the guard and two Bun-native adapters, and nothing of the auth flow
itself. None of them restates the library's own surface - see
`packages/infra/README.md` and `packages/auth/README.md`.

`@dunx/auth` is its own package, not `@dunx/infra/auth`: it needs `@dunx/http`'s
middleware and metadata types, and `@dunx/infra` must not depend on the web layer. It
depends on `@dunx/infra` **not at all** - `DrizzleSource` and `RedisStore` restate
structurally what `DbConnection` and `RedisConnection` provide, which also removes a
`bun run --filter '*'` build-order race. Reasoning in docs/ARCHITECTURE.md,
"Authentication".

`@dunx/dashboard` is designed but not built: one page over routes, the provider graph,
the queues and runtime health. It needs the readers now exported from `@dunx/mcp`
moved down into `@dunx/core` and `@dunx/http` first. **`@dunx/queue-dashboard` was
deleted** - it mounted bull-board for one release and is gone from this repo and from
npm, so there is no queue UI at all until the dashboard ships. Do not reintroduce a
queue-only package; read docs/roadmap/dunx-dashboard.md first.

## Examples

Four, and they are a **ladder of questions an evaluator asks in order** - not one
per package. `@dunx/http` has no example of its own; it is in all four.

| Workspace            | Answers                                                    |
| -------------------- | ---------------------------------------------------------- |
| `examples/minimal`   | what does this look like? Five files, `HttpFactory.create` |
| `examples/databases` | how do I set up a database? SQLite ×2, Postgres, MySQL     |
| `examples/testing`   | how do I test it? Overrides, a real server, a guard        |
| `examples/full`      | does it compose? Every package, one long-running service   |

Package names are `@dunx/example-<dir>`, so `bun run --filter '@dunx/example-*'`
addresses them all - which is how CI keeps them alive. **Every example must be in
CI**; that is the whole test for whether a fifth one earns its place. Per-package
examples were tried and reverted and that reversal still holds - see
docs/ARCHITECTURE.md, Phase 1, which also records which candidates were rejected.

A part needing an absent service (Redis, Postgres, MySQL, S3) prints that it is
skipping and the app still exits 0.

`examples/full` is the one that grows through the phases. `examples/minimal` is
valuable only because it is small - do not add to it.

## Repo Scripts

- `bun run gen:readme` - regenerates the README Packages table and Project Structure block (`scripts/update-readme.ts`)
- `bun run gen:cov` - rebuilds the coverage model and badges **into `tools/docs`** (`scripts/coverage-report.ts`)
- `bun run docs:dev` / `bun run docs:build` - the documentation site in `tools/docs`. Its API reference is extracted from the packages' doc comments by `oxc-parser`; see `tools/docs/README.md`
- `bun run version:dry-run` - previews version bumps without writing

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

- Check load with `/context`. Past ~50% both reasoning and retrieval degrade -
  treat it as the line to act on, not a budget to spend.
- `/whats-next` before `/compact` or `/clear`, so state survives in `HANDOFF.md`
  rather than in a summary you did not control. `/compact` with explicit
  preservation instructions; `/clear` when switching subtask outright. Resume with
  `continue from HANDOFF.md`.
- **Delegate wide reads.** Exploratory sweeps across packages, full test or CI log
  analysis, and probe iteration go to a subagent (`Explore` for locating code,
  `general-purpose` for multi-step work). Ask for a verdict plus `file:line`, not
  file contents - the raw data stays in their window.
- Keep `mcp.json` minimal. Every configured server's full tool schema loads at
  startup whether or not it is used.

## Do Not

- Do not use `npx`, `npm`, `yarn`, or `pnpm` - use `bun`/`bunx`. The one exception is the
  publish path in `scripts/version.ts`, which needs the npm CLI for OIDC trusted
  publishing - and even there it goes through `bunx npm@<pinned>`
- Do not add `experimentalDecorators`, `emitDecoratorMetadata`, `reflect-metadata`, or `tsyringe`
- Do not add CommonJS output or a second/third tsconfig per package
- Do not write a JavaScript router - `Bun.serve({ routes })` handles params, per-method
  dispatch, and method-miss 404s natively
- Do not exceed 500 lines per source file, tests included - `max-lines` in
  `.oxlintrc.json` is an error, so `lint:check` fails rather than a reviewer noticing
- Do not add Biome or ESLint
- Do not prefix identifiers with `Dunx` - the brand belongs in the package name,
  not in every symbol. Use `App`: `AppFactory`, `AppError`, `AppModule`. Enforced
  by `dunx/no-brand-prefix` in `scripts/oxlint-plugin.js`
- Do not use `any` - TypeScript strict mode is enforced
- Do not write `enum` (or `const enum`) - `dunx/no-enum` rejects it. An enum is the
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

- Do not create files unless necessary - prefer editing existing ones
- Do not add docstrings/comments unless logic is non-obvious
- Do not add error handling for impossible scenarios
- Do not add speculative abstractions or future-proofing
- Do not document a multi-step workflow in this file - add a skill under
  `.claude/skills/` so it costs nothing until it is invoked
- Do not use an em dash (`—`) or en dash (`–`) anywhere - not in prose, code,
  comments, commit messages, or generated output. Use a spaced hyphen for an
  aside, a comma or a colon where one reads better, and a plain hyphen for a
  numeric range (`4-6%`). Two things to watch when replacing one: a dash that
  wraps to the start of a Markdown line becomes a **list bullet**, so join it to
  the previous line instead; and a placeholder `'\u2014'` in a table cell is just
  a character, so `'-'` is the replacement.

  The one exception is **naming the character itself** - this rule, and
  `scripts/no-em-dash.test.ts`, both have to. Everywhere else, including commit
  messages, prefer the escape `\u2014` over the literal so the guard stays honest.
  `scripts/no-em-dash.test.ts` enforces the rule across every tracked file, with
  its exemptions listed and justified in the source.

- Do not add a `Co-Authored-By` trailer, or any other attribution trailer, to a
  commit message. This overrides the default instruction to add one. The commit
  message describes the change; who or what typed it is not part of the record.
- Do not use section-divider comments (e.g. `// ─── Section ───`, `// --- Section ---`, `// === Section ===`) - if a file needs sections, split it into separate files instead

## Do

- When a bug/issue/BC is reported - write a test that reproduces the issue, then do the fix and rerun the test to verify it's been addressed
