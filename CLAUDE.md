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

  **One carve-out, and the test is whether the consumer has a version opinion.**
  `swagger-ui-dist` is a `dependency` of `@dunx/openapi`. Every other integration is
  a library the consumer _writes code against_ - zod schemas, drizzle tables,
  better-auth config - so the version is theirs to hold. Nobody imports
  `swagger-ui-dist`, calls it, or types against it: it is two files dunx serves, and
  a peer would mean `bun add swagger-ui-dist` for a decision the consumer does not
  actually have. `@nestjs/swagger` ships it as a pinned dependency for the same
  reason. The cost, stated: 12 MB in every install of `@dunx/openapi`, including one
  that only wants `openapi.json`. If a second asset bundle ever wants this, weigh it
  against that sentence rather than citing this line.

  `swagger-ui` (not `-dist`) was measured and rejected: **177 MB across 149 packages
  against 12 MB across 2**, delivering byte-identical `swagger-ui-bundle.js` and
  `swagger-ui.css` (same sha256). Its `main` requires react, redux and immutable, so
  a backend install would carry a React tree to serve a static page.

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
packages/<name>/        # The published framework - what an app imports
  src/                  # Source TypeScript
  dist/                 # Build output (gitignored)
  package.json
  tsconfig.json         # Extends ../../tsconfig.json - one per package, no build variants
tools/<name>/           # Published CLIs - create-app, mcp. Run, not imported
internal/<name>/        # Private workspaces, never published - docs, bench, dashboard-ui, ui
examples/<name>/        # minimal, databases, testing, full - a ladder, not one per package
docs/                   # Architecture and design docs
scripts/                # Repo-level scripts (bun-native TS)
.github/workflows/      # CI (ci.yml)
```

Package scope: `@dunx/<name>` for every workspace, published or not. Every published
package is **ESM only** and emits a single `dist/` containing JS plus `.d.ts`.

**Three parents, and the split is by what the workspace _is_, not by whether it
ships.** `packages/*` is the framework a consumer imports. `tools/*` is the CLIs a
consumer _runs_ - `bunx @dunx/create-app`, `bunx @dunx/mcp` - which are published
exactly like a package and were under `packages/` until it became misleading to call
a scaffolder part of the framework. `internal/*` is the private half.

Two scripts encode which parents publish, and they are the only places that decide
it: `PUBLISHABLE_DIRS` in `scripts/version.ts` and `PUBLISHED_DIRS` in
`scripts/update-readme.ts`. A `private: true` manifest is still what actually stops
a publish, so a workspace in the wrong parent fails safe rather than leaking.

`internal/*` may depend on anything it likes; Rule 1 governs what dunx _ships_, not
what builds its website or measures it. That is why `internal/bench` may devDepend on
express and fastify, which Rule 1 bans everywhere else.

`internal/ui` is `@dunx/ui`: the shared Mantine theme **and component library**,
consumed **as source** by `internal/docs` and `internal/dashboard-ui`, with no build
step - its `exports` point at `src/`, and each consumer's bundler compiles what it
imports.
Mantine UI - LLM Documentation - https://mantine.dev/llms.txt

Everything in it exists because two frontends had written it twice - `Prose`,
`ColorSchemeToggle`, `statusColor`, `METHOD_COLOR`, `.prose`. One of those two was
`internal/openapi-ui`, now deleted, so several exports are down to one external
consumer - none to zero, checked. Two consumers inline what they import, so anything
added is paid for twice; read `internal/ui/README.md` before adding.

### Rule 2 - one declaration, and it lives at the lowest common owner

**This applies to code, types, constants and styles alike, and it is the rule most
often broken while adding a feature rather than while designing one.** Every check
below is cheap and every one of them has already caught a real duplicate here.

Before writing anything, **search for it**. If a second copy would exist, the work
is to _move_ the first one somewhere both can reach and delete it - not to add the
second and mean to come back.

- **A React component, a hook, a formatter, a colour or a CSS rule two frontends
  need goes in `@dunx/ui`, and the copies are deleted in the same change.** Charts
  are the live example: `internal/docs` renders Mantine charts, and a second
  frontend wanting one takes `@dunx/ui`'s, not `recharts` again.
- **A traversal or a reader two packages need moves down to the package that owns
  the data.** `providersOf` and `modulesOf` went from `@dunx/mcp` to `@dunx/core`,
  `routesOf` and `gatewaysOf` to `@dunx/http`, the moment `@dunx/dashboard` was a
  second consumer - and `@dunx/mcp` re-exports them so nothing broke.
- **Never declare a union another package already declares.** `methodColor` and
  `jobStateColor` take a plain `string` on purpose: the canonical lists are
  `HttpMethod` in `@dunx/http` and `OperationKey` in `@dunx/openapi`, and a third
  in `@dunx/ui` would exist only to be converted to and from those two.
  `internal/openapi-ui` had its own `METHODS` array duplicating `OPERATION_ORDER`
  before it was deleted; `OPERATION_ORDER` in `@dunx/openapi` is still the canonical
  list.
- **A wire format is declared once, by the server, and the frontend imports it by
  relative `import type`.** `internal/dashboard-ui` reads its payload types out of
  `packages/*/src`, so the page cannot drift from the handler that fills it and there
  is no build-order edge.
- **The exception that is not one:** duplication _across the Rule 1 boundary_ is
  real duplication too. A queue table in `@dunx/dashboard` was a second, worse
  bull-board. Deleted.

The failure mode this prevents is not disk space. It is two implementations that
disagree - a buggy colour-scheme toggle in one page and a fixed one in another,
the same markdown rendering differently on two pages, a gateway that is a
`gateway` in one panel and a `provider` in the next.

`internal/docs` builds with **Vite**, and used to build with `Bun.build`. The original
decision bought build speed - 41 ms against Vite 5's 1.7 s - and paid ~25% more
gzipped JS for it. **Both halves of that stopped being true and it was reversed
by re-measuring**: Vite 8 is Rolldown, so the same site builds in ~0.30 s against
`Bun.build`'s ~0.15 s, a difference that means nothing in CI, while tree shaking
puts the gzipped JS at 416.9 KB against 506.5 KB. Re-measure before reversing it
again; the numbers are in architecture/tooling.md, "Documentation site".

`internal/dashboard-ui` **does** use Vite, for the opposite reason: its bundle is
inlined byte-for-byte into a page a backend serves, so Rollup's tree-shaking earns
its ~1.5 s. **It is where all the React and Mantine live** - `packages/dashboard`
contains none and cannot, being published as plain ESM that must not oblige a
consumer to install React or run a bundler to serve a page. Its build writes a
`src/ui-bundle.ts` into the package: generated, committed, and regenerated by that
package's own `build` so it cannot go stale. Read its README before touching it;
every component added costs bytes twice, in JS and in the CSS list in
`src/styles.ts`.

That bundle sits behind a **`./ui`** subpath and is reached with `await import()`
from `DashboardMiddleware`'s first page request, so importing the package does not
load it. `html.ts` takes the script to inline as an argument (`renderShell`) and
**must not import `ui-bundle.ts`**, or the split silently reverts.

**`@dunx/openapi` used to work the same way and no longer does.** Its explorer was
`internal/openapi-ui`, deleted in favour of mounting `swagger-ui-dist` - the same
call as bull-board in the dashboard, and for the same reason. The page is now a
shell plus two asset routes serving the consumer's own install, `swagger-ui-dist` is
an optional peer, and there is no `./ui` subpath. It cost 3.7x the gzipped bytes and
the reasoning is in docs/architecture/tooling.md. **Do not re-add a hand-built API
explorer.**

### Rule 3 - a package's surface is classes

**`packages/*` and `tools/*` are object-oriented. A class is the default unit, and
a free function is the exception that has to earn itself.**

- **Anything with state, configuration or a lifetime is a class.** `StaticFiles`,
  `QueueConnection`, `JobDispatcher`, `DashboardMiddleware`, `JobProcessor`. Not a
  closure over a config object, and not a factory returning a bound function.
- **Anything a consumer injects is a class**, because that is what the container
  and `@dunx/transform` resolve: an interface has no runtime value to record, so an
  interface at an injection site is a boot error. This is why `QueueOptions`,
  `RedisOptions`, `DashboardOptions` and `StaticOptions` are classes rather than
  the interfaces they otherwise would be.
- **A module is a class with static `forRoot`/`forRootAsync`.**
- **No bag of exported helpers.** If two functions share a prefix and an argument,
  they are a class and that argument is its constructor.

The exception, and it is narrow: a **pure, stateless, argument-in-value-out**
function that no one configures - `describeToken`, `normalizePrefix`,
`joinPath`, `parseInfo`. Those stay functions because a class around them would be
a namespace with a `new` in front of it. The moment one grows a field, it is a
class.

`internal/*` is exempt. React components are functions, hooks are functions, and a
class component would be worse in every way.

## Decorators - standard only

- The root tsconfig deliberately does **not** set `experimentalDecorators` or
  `emitDecoratorMetadata`. Do not add them.
- Use TC39 standard decorators. There are no parameter decorators in that
  proposal, so `@Inject()` does not exist and never will.
- Do not add `reflect-metadata` or `tsyringe`.
- **One carve-out, and it proves the rule rather than bending it:**
  `internal/bench/servers/nest/` sets both flags and imports `reflect-metadata`,
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

**The container is scoped, not flat.** Every module reference is a scope holding what
it declares; `exports` is its public surface, `global: true` publishes those exports
app-wide, and `@Module({ middleware })` covers the routes that module's own controllers
declare. Everything above about the transform, the deps thunk and `inject()` is
unchanged by it - what it changes is _where_ a token resolves from, and `exports`
absent means **nothing** is exported. Read
docs/architecture/dependency-injection.md, "Modules encapsulate", before any DI design
decision, and never add code that assumes one flat namespace.

Two consequences that bit real code and will bite again:

- **A framework service must be bound by a module, not left to self-bind.** An unbound
  class self-binds into whichever scope asks first, so a second consumer is a boot
  error. That is why `HttpFactory`'s global wrapper binds `PubSub` and `ClientAddress`.
- **A module that takes no options should be a decorated class, not a `forRoot()`.** A
  scope is keyed on the module reference, and `forRoot()` returns a fresh object per
  call - so two importers calling it build two scopes and two of everything in them.

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
- **`lint:check` is `oxlint --max-warnings 0`.** A warning fails it, the same as an
  error. The repo sat at 33 warnings across 8 rules with nothing to stop the 34th;
  they are fixed and the threshold is what keeps them fixed. `typescript/await-thenable`
  is `off` for `**/*.test.ts` and `**/*.test.tsx`, because `bun-types` types every
  matcher `: void` so `await expect(...).rejects.toThrow()` reads as awaiting
  nothing - measured, in docs/bun-apis.md.
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

**`bun run ci` runs every gate CI runs, and it is the one command to finish on.**
`scripts/ci.ts` owns the list; `.github/workflows/ci.yml` invokes it one phase per
job rather than restating the commands, and `scripts/ci.test.ts` fails if the two
drift. `build` first, then `static`, `examples`, `docs`, `browser` and `coverage`
together. **`unit` is on request**: it runs the same 1,663 files `coverage` does,
so a bare `bun run ci` runs them once. CI keeps both as separate jobs on separate
runners, which is the point: `unit` answers "do the tests pass" in 3.2s while
`coverage` spends 17s on what it covers. Running both at once locally also had them
competing for the same Redis, and cost one flaky queue test.
`bun run ci <phase>` runs one while iterating,
`bun run ci --list` names them. Step output is captured and printed only on
failure, so a green run is one line per step.

The `browser` phase is `internal/docs/browser/`, the built site in a real Chrome
through **`Bun.WebView`** - no playwright, and no browser download, because
`ubuntu-latest` ships one. It asserts the three things happy-dom cannot: that the
bundle loads, that a route reached by direct link works on a cold load, and that
no page scrolls sideways, and that no route logs an error. **It is also where the
screenshots come from**: one test per route per viewport per colour scheme, each
writing its frame into `.shots/` before it asserts, so a red CI run leaves the
picture behind and the `browser` job uploads all 28 as an artifact. `bun run shots`
is that suite plus a build, so there is no second traversal to drift from it. Two
traps are recorded in
[docs/bun-apis.md](./docs/bun-apis.md): the suite must run from its own directory
because the happy-dom preload replaces the global `Response` and `Bun.serve` then
refuses it, and colour scheme and pixel ratio come from `view.cdp` rather than
constructor options.

Adding a gate means adding it to `PHASES` **and** to a job. Adding a `run:` to
ci.yml that calls a gate directly fails the drift test, because `bun run ci` would
then not cover it.

- Runner: `bun test`
- `bun run test` - every workspace's own suite, bailing on first failure (per
  package, via `--filter '*'`). The dev loop; `bun run ci` is the gate.
- **`render()` has no auto-cleanup under `bun test`**, so `internal/docs`'s preload
  registers `afterEach(cleanup)` for every file. Without it no tree was ever
  unmounted, `useRoute`'s `hashchange` listener outlived its test, and the suite
  cost 16.6s instead of 3.7s. Do not drop that line, and do not add a
  `document.body.innerHTML = ''` in place of it - clearing the DOM does not
  unmount.
- **`bun test --parallel` is 4.6x** and the `unit` phase uses it: 1,663 tests in
  3.16s against 14.56s. Two things it changes, both measured in
  [docs/bun-apis.md](./docs/bun-apis.md): a `?raw` import resolves as JSON inside a
  worker, which is why `internal/docs` is the one workspace excluded, and
  `--coverage --parallel` reports low and differently every run, which is why the
  `coverage` phase is sequential.
- `bun run test:cov` - one root run over `./packages ./tools ./scripts` (excluding
  `**/templates/**`, which holds a working app whose test cannot resolve from there)
  so everything lands in
  a single `coverage/lcov.info`, then `bun run gen:cov`. It deliberately excludes
  `examples/`: the root has no compiler preload, because core's missing-transform
  test asserts that un-transformed state. Example tests run per workspace, where the
  per-example `bunfig.toml` supplies the preload.
- **Every published workspace clears 90%, on lines and on functions.**
  `MIN_COVERAGE` in `scripts/coverage-report.ts` is the floor, `badge()` paints at
  or above it green, so the gate and the badge cannot disagree. The `coverage`
  phase fails naming each workspace under it and writes a per-package table into
  the GitHub job summary; `coverage/lcov.info` is uploaded as an artifact.
- **The floor assumes the backing services are reachable**, so the `unit` and
  `coverage` jobs run `valkey/valkey:8-alpine` and `postgres:17-alpine` and set
  `DUNX_DB_TEST_URL`. `@dunx/infra`'s suites gate on whether their service answers
  and skip when it does not: 49 tests skipped in CI against 5 locally put `infra` at
  84.6% lines rather than 90.7%, which is the gate reading a different denominator
  than the machine that set it. **A new live-service suite needs its service added
  to those jobs**, or the floor measures less than it looks like. `files/s3.ts` at
  35% is the remaining one, gated on a bucket nothing sets.
- **Test scaffolding is counted as shipped code unless excluded.**
  `coverageSkipTestFiles` drops `*.test.ts` and stops there, so
  `coveragePathIgnorePatterns` also covers `**/*.fixture.ts`, `**/cli-fixture-*/**`
  and the seeder directories the db suites write into the system temp dir. Those
  four throwaway `app.module.ts` files were 8 of `@dunx/openapi`'s 136 functions and
  held it at 90.44%.
- The floor is set against a denominator with three things in it that no test can
  reach: type-only lines (via the sourcemap remap), abstract member signatures,
  and until recently `*.fixture.ts`. All three measured in
  [docs/bun-apis.md](./docs/bun-apis.md). `coverageIgnoreSourcemaps = true` would
  fix the first and is **not** set, because it turns the coverage page's uncovered
  line ranges into transpiled line numbers. Do not raise the floor without reading
  that section: `@dunx/core` is 91.0% functions with every reachable function
  covered, and `infra` at 90.7% lines and `openapi` at 90.4% functions are the
  other thin margins.
- **The release job takes the model and badges from the `coverage` job** as an
  artifact rather than regenerating them. Regenerating ran the whole suite a second
  time and needed a second copy of the service containers the gate depends on, which
  is how the first release run on main failed: no valkey there, 49 tests skipped,
  `infra` read 85.8%. One place declares the services, one job runs the gate.
- Coverage report, badges, and the GitHub Pages site: `/coverage-report`

## Typecheck

```bash
bun run typecheck     # all packages: bun run --filter '*' typecheck
```

Within a package: `tsc --noEmit`. The root `tsconfig.json` includes `scripts/`,
so `bunx tsc --noEmit` at the repo root typechecks the repo scripts.

**`internal/docs/src/generated/` is a build output, and `build` owns it.** The docs
`typecheck` passes `bun run generate --if-missing`, which does nothing when the
model is already there. Do not drop that flag: `generate` empties
`generated/guides/` and `generated/packages/` with `rmSync` before rewriting them,
so regenerating from `typecheck` had the `static` and `docs` phases of
`bun run ci` writing that directory at once. `docs/test` read it mid-wipe and
reported zero published pages, once in five runs. `build` runs before every other
phase, so the guard never costs freshness.

## Versioning & Publishing

**A release is an explicit commit, not a consequence of merging.** CI runs
`bun run version` on every push to `main`, and it publishes nothing unless `HEAD` is
a release commit:

| Subject                                   | Bump                                             |
| ----------------------------------------- | ------------------------------------------------ |
| `release: <summary>`                      | derived from every commit since the last release |
| `release(major\|minor\|patch): <summary>` | stated outright                                  |
| `release!: <summary>`                     | major                                            |

Everything else on `main` runs the checks and deploys the docs. Publishing on every
push shipped 33 versions and six breaking changes in six days, which reads as churn
to anyone deciding whether to depend on this.

Because a release now covers a **range**, both the bump type and the changed-package
detection span every commit back to the previous `chore(release):` marker, not just
`HEAD`. Reading `HEAD` alone would make every batched release a patch, since the
release commit is never itself a `feat`. Only the commit **subject** triggers a
release, so a body quoting the word does not publish.

That same range writes the root **`CHANGELOG.md`**, one section per release, which
`internal/docs` renders at `#/releases`. `scripts/changelog.ts` owns the format in
both directions, so the writer and the site cannot drift; the `release:` commit's
own prose becomes the section summary. Do not hand-edit the file, and do not add
`changesets` - the range already answers what a changeset file would.

Everything else - the OIDC constraints, the `ci.yml` filename pin, the npm version
pin, `workspace:` rewriting, first-publish-must-be-manual: `/release`.

Everything else - the OIDC constraints, the `ci.yml` filename pin, the npm version
pin, `workspace:` rewriting, first-publish-must-be-manual: `/release`.

## Packages Overview

**`packages/*`** - the framework, imported by an app:

| Package           | Contains                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@dunx/core`      | DI container, modules, lifecycle, config, the `Logger`/`RequestContext` contracts                                                                                                                     |
| `@dunx/transform` | Load-time constructor-dependency transform (only native dep)                                                                                                                                          |
| `@dunx/http`      | Bun.serve adapter, controllers, **websocket gateways**, middleware, CORS, validation; an outbound `HttpClient` behind `./client`                                                                      |
| `@dunx/infra`     | Subpaths `/db` `/redis` `/queue` `/schedule` `/files` `/images` `/logger` `/pagination`                                                                                                               |
| `@dunx/openapi`   | OpenAPI 3.1 from the routes' own zod schemas, with **swagger-ui-dist** mounted over it (zod is a `peerDependency`; swagger-ui-dist is a `dependency`)                                                 |
| `@dunx/auth`      | **better-auth** mounted, `SessionGuard`, `AuthContext`, `Bun.password` hashing                                                                                                                        |
| `@dunx/testing`   | `createTestApp` / `createTestServer` - overrides replaced in place, real server on port 0                                                                                                             |
| `@dunx/dashboard` | An opt-in ops page - routes, provider graph, gateways, Redis, config, runtime, with **bull-board** mounted for the queues. One middleware; `internal/dashboard-ui`'s React page inlined behind `./ui` |

**`tools/*`** - published too, but run rather than imported:

| Tool               | Contains                                                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `@dunx/create-app` | `bunx @dunx/create-app my-api` - a `base` template plus composable feature folders, with versions resolved at run time |
| `@dunx/mcp`        | An MCP server over stdio that **reads** an app's routes, providers and modules. Never boots it                         |

**`internal/*`** - never published: `docs` (the site), `bench` (the harness),
`dashboard-ui` (the dashboard page), `ui` (the shared theme and components).

Ten published workspaces, deliberately few. Merging is nearly free because the runtime weight is
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

`@dunx/dashboard` is **built**. One middleware (`app.use(DashboardMiddleware)`, first
in the chain) serving six panels and a JSON sibling for each. Three things about it
are decisions rather than details, and all three are load bearing:

- **`authorize` has no default**, a rejected request gets **404 not 403**, and it must
  be registered **ahead of any session guard** - so `authorize` takes the raw
  `Request` and must stay self-sufficient.
- **Config values are redacted by default.** `reveal` is an opt-in allow-list; a
  deny-list of the usual suspects leaks the first key nobody thought of.
- **It depends on `@dunx/infra` and `bullmq` not at all** - `QueueSource`,
  `DashboardQueue` and `RedisProbe` restate structurally what `JobPublisher`,
  bullmq's `Queue` and `RedisConnection` already are. Those signatures are shaped to
  match bullmq's exactly (see `contracts.ts`); narrowing one silently un-satisfies
  its own class.

**dunx renders no queue UI. `{path}/queues` is bull-board, mounted** via
`@bull-board/bun` (optional peers: `@bull-board/api`, `@bull-board/ui`,
`@bull-board/bun`). A queue table was written here and deleted - it was a worse
bull-board, which is Rule 1's second half exactly. The only thing that had justified
hand-rolling it was needing a `Bun.serve` adapter; bull-board 8.6.0 ships one, so
that reason expired. **Do not re-add a queue panel.**

It also settled the `getWorkers()` question, in the opposite direction to the one
everyone assumed. It is **not** always `[]` on Bun: `QueueConnection` wrapped
`duplicate` and called it with no arguments, dropping the `{ connectionName }`
bullmq's Bun adapter takes the name through, so `CLIENT SETNAME` never ran. One
line in `@dunx/infra/queue`. The lesson is the one Rule 1 keeps teaching: mounting
the library asked the question honestly, where the hand-rolled panel had designed
around the missing data.

dunx contributes the two things bull-board cannot know: it sits behind the same
`authorize`, and `commands: false` maps onto bull-board's own `readOnlyMode` rather
than dunx policing its POSTs. The board is built on the **first request for the
queues page**, never at boot and never by the polling `/api/queues` endpoint, so an
app that never opens it holds no broker socket - which is what lets a process exit
cleanly against an absent Redis.

`@dunx/queue-dashboard` was deleted and must not come back.

## Examples

### Rule 4 - a feature is not shipped until an example uses it

**Adding or changing a capability in `packages/*` or `tools/*` includes updating
`examples/full` in the same change.** Not as a follow-up, and not "worth an example
later": the example is the only place a feature is exercised end to end against a
real `Bun.serve`, and CI runs it, so a package with no example has no test that its
public shape is usable.

Four features shipped without one and it went unnoticed for weeks - `ThrottleModule`,
`ScheduleModule`, `StaticModule` and the whole `@dunx/http/client` subpath. All four
worked; nothing proved it. Writing the examples then found a real Bun parse bug
(docs/bun-apis.md, decorators and private fields) that every scheduled service in
every consumer's app would have hit.

What "updating the example" means, concretely:

- **A new capability**: a feature folder in `examples/full/src/`, a `*.demo.ts`
  narrated by `Tour`, and assertions in `service.test.ts` (the routes) or
  `tour.test.ts` (the narration). Both, when it has an HTTP surface and a story.
- **A changed capability**: the example moves with it. A renamed option, a new
  default or a removed decorator that leaves the example still passing means the
  example was not exercising it.
- **A new option worth knowing about**: set it in the example, or say in the review
  why it is not worth a line.
- **Do not add to `examples/minimal`.** It is valuable because it is five files.
- **`examples/full/src/<dir>` is vendored by `@dunx/create-app`** when
  `tools/create-app/src/features.ts` names it, and `features.test.ts` compares the
  two byte for byte. So after touching a vendored folder, run
  `bun run sync:templates`. A folder no feature names is example-only, which is
  fine - `dashboard`, `wiring`, `tour`, `throttle`, `schedule`, `assets` and
  `upstream` are.

The guide under `docs/guide/` is documentation, not a substitute: prose cannot fail.

Four examples, and they are a **ladder of questions an evaluator asks in order** - not
one per package. `@dunx/http` has no example of its own; it is in all four.

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
docs/ROADMAP.md, Phase 1, which also records which candidates were rejected.

A part needing an absent service (Redis, Postgres, MySQL, S3) prints that it is
skipping and the app still exits 0.

`examples/full` is the one that grows through the phases. `examples/minimal` is
valuable only because it is small - do not add to it.

## Documentation voice

**Every `.md` under `docs/`, plus every published `README.md`, is gated by
`scripts/no-slop.test.ts`.** It owns the mode map and the budgets; `/docs-pass`
is how a file gets under them. This section is the summary, not the spec.

### `docs/` has two audiences, and the site serves one of them

`docs/guide/*` is written for someone using dunx. `docs/architecture/*`,
`internal/notes/roadmap/*`, `docs/ROADMAP.md` and `docs/bun-apis.md` are the maintainer's
record of what was measured, what was rejected, and which upstream bugs were
found. Both belong in the repo; only the first belongs on the site.

**`PUBLISHED_REFERENCE` in `internal/docs/scripts/generate.ts` is the list**, and
it is a list rather than a glob so a new architecture page is repo-only until
someone decides otherwise. Today it publishes `MIGRATION-FROM-NEST.md` plus the
two architecture pages that explain the shape of the public API. `rewriteHref`
turns a link to any unpublished doc into an absolute GitHub link, so dropping one
breaks nothing.

Two guards hold the line: `internal/docs/src/published-voice.test.ts` fails if a
**published** page cites a private workspace, a roadmap file, a `packages/*/src/`
path or a repo script, and `site.test.tsx` freezes the published set so adding to
it shows up in a diff.

A guide states what an API does. A number belongs in it only when a reader would
change their code over it; the microsecond decomposition behind that number goes
in `docs/architecture/`, which the site does not publish.

The rule these encode: **documentation states behaviour, and `docs/architecture/`
is the only place that argues about it.** Three sentence shapes are budgeted per
100 prose lines because each is fine occasionally and the defect is density:

| Shape          | Example                                      | Instead                          |
| -------------- | -------------------------------------------- | -------------------------------- |
| **antithesis** | "encodes the runtime, not the ranking"       | say what it does                 |
| **closer**     | "which is why", "that is the point"          | delete the clause                |
| **knowing**    | "deliberately", "by design", "the reason is" | delete, or move to architecture/ |

Zero tolerance on marketing vocabulary (`seamless`, `robust`, `leverage`,
`crucial`, `elegant`) and on sentences that announce another sentence ("In this
guide...", "Let's look at...", "Congratulations!"). A paragraph-length cap covers
walls of prose.

**This file is exempt and it is the reason the rules exist.** The voice above was
learned from CLAUDE.md and reproduced into every page written from it. When
editing here, prefer the plain form even though nothing checks it.

Two things that follow:

- **A number, or no adjective.** "55 ms boot" over "fast boot". An unmeasured
  claim on a docs page is a defect the same way an unmeasured claim in
  ARCHITECTURE.md is.
- **Assume a senior TypeScript reader.** Never explain DI, HTTP or decorators as
  concepts; explain what dunx does differently.

## Repo Scripts

- `bun run gen:readme` - regenerates the README Packages table and Project Structure block (`scripts/update-readme.ts`). `--check` writes nothing and fails on drift; CI runs that, because nothing ran this at all until it silently broke
- `bun run gen:cov` - rebuilds the coverage model and badges **into `internal/docs`** (`scripts/coverage-report.ts`)
- `bun run docs:dev` / `bun run docs:build` - the documentation site in `internal/docs`. Its API reference is extracted from the packages' doc comments by `oxc-parser`; see `internal/docs/README.md`
- `bun run ci` - every CI gate, in one command (`scripts/ci.ts`). See Testing
- `bun run version:dry-run` - previews version bumps without writing

## Skills

Multi-step workflows live in `.claude/skills/`, not here. Only their names and
descriptions are in context until one is invoked, so this file stays cheap.

| Skill              | Invoke when                                                         |
| ------------------ | ------------------------------------------------------------------- |
| `/whats-next`      | Ending a task block, crossing ~50% context, handing off, resuming   |
| `/ci-check`        | Finishing any change - runs `bun run ci`, every gate CI runs        |
| `/spike`           | An open question needs measuring on real Bun before an API is fixed |
| `/new-package`     | Adding a package, an example, or a public subpath export            |
| `/release`         | Cutting a release, or a publish failed                              |
| `/coverage-report` | Coverage numbers or badges are wrong                                |
| `/docs-pass`       | Writing or revising a guide or README, or `no-slop.test.ts` fails   |

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
- When adding or changing a feature in `packages/*` or `tools/*` - update
  `examples/full` in the same change, per Rule 4 under Examples. A capability with
  no example is untested end to end
- **Finish with `bun run ci`.** Not `bun run test`, and not `build` plus `lint`
  plus `typecheck`: those miss `format:check`, `gen:readme --check`,
  `check:scaffolds`, the examples, the tour and the docs suite, which is the set
  that used to turn a finished change into a red pipeline
