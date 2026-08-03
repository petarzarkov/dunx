# Contributing to dunx

Thanks for wanting to help. dunx is a Bun-native dependency injection framework,
and it has a small number of rules that are unusual enough to be worth reading
before you write code. Most of a review here is spent on the rules below, so
skimming this page first will save you a round trip.

If something in here is wrong or missing, that is a bug too. Open an issue.

## Prerequisites

**Bun 1.3 or newer, and nothing else.** Bun is the runtime, the test runner, the
bundler and the package manager.

```bash
curl -fsSL https://bun.sh/install | bash
bun --version   # CI pins 1.3.14
```

`npm`, `npx`, `yarn` and `pnpm` are never used in this repo. Run tools with
`bunx`, scripts with `bun run <script>`, and TypeScript files directly with
`bun <file.ts>`.

There is exactly one exception, and it is not yours to run: the publish path in
`scripts/version.ts` needs the npm CLI for npm trusted publishing (OIDC), and even
there it goes through `bunx npm@<pinned>` rather than a globally installed npm.
CI drives it. If you find yourself reaching for `npm` anywhere else, that is the
signal something is off.

## Getting set up

```bash
git clone https://github.com/petarzarkov/dunx.git
cd dunx
bun install
bun run build
```

Build before anything else. `examples/*` consume the packages through their
published `exports` maps, so nothing under `examples/` can typecheck until
`dist/*.d.ts` exists. CI builds first for the same reason.

### What the topological build does

`bun run build` is `bun scripts/build-all.ts`, not `bun run --filter '*' build`.

The filter form orders workspaces by `dependencies` alone. That was fine while
every internal edge was a real dependency, and it broke the moment one became a
`peerDependency`: `@dunx/core` is now a peer of `@dunx/http`, Bun was not told the
two were related, built them concurrently, and `tsc` raced core's own `.d.ts` emit
and failed with `TS7016`.

`scripts/build-all.ts` topologically sorts every workspace that has a `build`
script, counting `dependencies`, `devDependencies` **and** `peerDependencies`,
restricted to workspace packages. It emits **waves** rather than a flat queue
(Kahn's algorithm, one round per iteration), so packages with no edge between them
still build at the same time and the common case costs nothing. A cycle between
workspaces is a hard error naming the packages involved.

Per package, `build` is `bun ../../scripts/build-package.ts`, one implementation
for all of them. It derives its entrypoints from the manifest's `exports` and `bin`
fields, so a new public subpath cannot be added without also being built.
`Bun.build` emits the JS and `tsc --emitDeclarationOnly` emits the `.d.ts`, because
Bun has no `--dts`.

## The checks

Run these before you push. CI runs the same set, in this order.

| Command                | What it does                                                                |
| ---------------------- | --------------------------------------------------------------------------- |
| `bun run build`        | Topological build of every workspace, JS plus `.d.ts`                       |
| `bun run lint:check`   | oxlint, no fixing                                                           |
| `bun run format:check` | oxfmt, no writing                                                           |
| `bun run typecheck`    | `tsc --noEmit` in every workspace                                           |
| `bun run test:cov`     | One root run over `./packages ./scripts`, then rebuilds the coverage report |
| `bun run test`         | Every workspace's own suite, bailing on first failure                       |

`bun run lint` and `bun run format` are the fixing variants. **CI runs the
`:check` variants on purpose**: an auto-fixing CI step would let a violation pass
green and never reach the repo. Use the fixing ones locally, commit the result.

A pre-commit hook runs lint-staged over staged `.ts` files, which lints then
formats them. It is not a substitute for running the full set once before you open
the PR.

Two notes on `test:cov`. It runs from the root so everything lands in a single
`coverage/lcov.info`, and it carries
`--path-ignore-patterns='**/templates/**'` so `packages/create-app`'s scaffolding
templates are not treated as source. It deliberately does **not** cover
`examples/`: the root has no transform preload, because one of core's tests asserts
what happens in exactly that un-transformed state. Example suites run from their
own workspaces, where each `bunfig.toml` supplies the preload. CI therefore has
separate steps for the examples, the docs site, the `examples/full` tour and the
`examples/databases` run.

## Repo layout

```
packages/*     Published, scope @dunx, ESM only, one dist/ each
examples/*     Private apps that consume the packages
tools/*        Private workspaces, never published
docs/          Architecture, roadmap, the guide
scripts/       Repo-level scripts, bun-native TypeScript
```

**`packages/*`** is the shipped surface: `core`, `transform`, `http`, `infra`,
`openapi`, `auth`, `testing`, `create-app`. Eight, deliberately few. Each has one
`tsconfig.json` extending the root, one `dist/`, and no build variants.

**`examples/*`** is a ladder of the questions an evaluator asks in order, not one
example per package.

| Example              | Answers                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| `examples/minimal`   | What does it look like? Five files. Valuable because it is small, so do not add to it  |
| `examples/databases` | How do I set up a database? SQLite twice, Postgres, MySQL                              |
| `examples/testing`   | How do I test it? Overrides, a real server, a guard                                    |
| `examples/full`      | Does it compose? Every package in one long-running service. This is the one that grows |

Every example is kept alive by CI, and every example exits 0 with no database,
Redis or S3 installed: a part whose backing service is absent prints that it is
skipping and carries on. An example CI cannot run is an example nobody notices has
rotted.

**`tools/*`** are workspaces but `"private": true` and never published:
`tools/bench` (the benchmark harness), `tools/docs` (the documentation site) and
`tools/openapi-ui` (the explorer inlined into the page `@dunx/openapi` serves).
They are **exempt from Rule 1**, which governs what dunx ships, not what measures
it or builds its website. That is why `tools/bench` may devDepend on express and
fastify while Rule 1 bans both everywhere else.

**`docs/`** holds [ARCHITECTURE.md](docs/ARCHITECTURE.md) (the decisions and the
measurements behind them), [ROADMAP.md](docs/ROADMAP.md) (what is built and what is
next), [bun-apis.md](docs/bun-apis.md) (what has actually been probed on real Bun),
[MIGRATION-FROM-NEST.md](docs/MIGRATION-FROM-NEST.md), and
[docs/guide/](docs/guide/), a seventeen-page tour from introduction through
deployment. If you add a feature, the guide is usually where a user will look for
it.

## Rule 1: native implementations only

This is the rule that outranks everything else, and the one most likely to get a PR
sent back. It has two halves that pull in opposite directions on purpose.

### Never reimplement what Bun already does

If Bun ships it, use Bun. In order of preference:

1. A `Bun.*` API or `bun:*` module: `Bun.serve`, `Bun.SQL`, `bun:sqlite`,
   `Bun.RedisClient`, `Bun.file`, `Bun.Image`, `Bun.Glob`, `Bun.password`,
   `Bun.CryptoHasher`, `Bun.color`, `Bun.S3Client`.
2. A Web standard Bun implements natively: `Request`, `Response`, `Blob`, `URL`,
   `WebSocket`, `ReadableStream`, `crypto.subtle`, `AsyncLocalStorage`.
3. A native module via N-API. `oxc-parser` in `@dunx/transform` is the precedent: a
   Rust parser chosen over a JavaScript AST library. Adding one needs a note in
   ARCHITECTURE.md saying which Bun API was missing.

Banned outright in `packages/*`, because Bun already does the job: `express`, `ws`,
`socket.io`, `ioredis`, `pg`, `mysql2`, `better-sqlite3`, `postgres.js`, `sharp`,
`jimp`, `image-size`, `glob`, `chokidar`, `axios`, `node-fetch`, `bcrypt`,
`dotenv`, `@aws-sdk/*`, `lodash`.

Relatedly, do not write a JavaScript router. `Bun.serve({ routes })` handles path
params, per-method dispatch and method-miss 404s in native Zig, and dunx's job is
to emit the `routes` object at boot.

### Never invent what a mature library already solves

The other failure mode is worse: hand-rolling an ORM, a validator, an auth system
or a job queue. Those are years of edge cases, and a half-built one is a liability
dressed as a feature. Where Bun ships no primitive for a hard problem, dunx
integrates the best-in-class library instead of competing with it.

Sanctioned integrations: **zod** (validation), **drizzle-orm** (ORM and
migrations), **better-auth** (authentication), **bullmq** (queues). Adding a
further one is a design decision, so raise it in an issue first.

Rules for integrations:

- They go in **`peerDependencies`**, with `peerDependenciesMeta.optional` where the
  feature is opt-in. Never `dependencies`. The consumer installs the library and
  owns its version; dunx does not bundle it.
- Where the library ships a Bun-native driver, that driver is mandatory:
  `drizzle-orm/bun-sqlite` and `drizzle-orm/bun-sql`, never `pg` or
  `better-sqlite3`. The library owns the abstraction, Bun owns the I/O.
- dunx's own contract stays library-agnostic where a standard exists. Route
  validation targets Standard Schema, an interface with zero runtime cost, so Zod,
  Valibot and ArkType all work.

Do not write a dunx ORM, a dunx validator, a dunx auth flow or a dunx job queue.

`docs/bun-apis.md` is not exhaustive. Bun ships undocumented APIs and several
documented ones misbehave, so probe the runtime before concluding anything, and
record what you verify.

## House style

These will fail CI or a review. Most are mechanically checked.

- **No `enum`, and no `const enum`.** Enforced by `dunx/no-enum` in
  `scripts/oxlint-plugin.js`. An enum is the one TypeScript construct that cannot
  be erased: it emits a runtime object with reverse mappings. Use a frozen object
  plus an indexed-access union, exporting one name for both the value and the type:

  ```ts
  export const HttpStatusCode = Object.freeze({
    OK: 200,
    NOT_FOUND: 404,
  } as const);
  export type HttpStatusCode =
    (typeof HttpStatusCode)[keyof typeof HttpStatusCode];
  ```

- **No `any`.** `typescript/no-explicit-any` is promoted to error, alongside
  `no-unused-vars` and `prefer-const`. Use proper types or generics.
- **No `Dunx` prefix on identifiers.** The brand belongs in the package name, not
  in every symbol: `AppFactory`, `AppError`, `AppModule`. Enforced by
  `dunx/no-brand-prefix`.
- **No em dash and no en dash. Anywhere.** Not in prose, code, comments, commit
  messages or generated output. `scripts/no-em-dash.test.ts` scans every tracked
  **and untracked** file and fails the build over a single one. Use a spaced hyphen
  for an aside, a comma or a colon where one reads better, and a plain hyphen for a
  numeric range (`4-6%`). Watch two things when replacing one: a dash that wraps to
  the start of a Markdown line turns into a list bullet, so join it to the previous
  line instead, and a placeholder in a table cell is just a character, so `-` is the
  replacement.
- **Relative imports carry a `.js` extension.** `tsc` copies the specifier verbatim
  into the emitted `.d.ts`, and an extensionless one fails to resolve for consumers
  on `node16`/`nodenext`. `moduleResolution: nodenext` in the root tsconfig makes
  this your compile error instead of a user's runtime error.
- **`"type": "module"` in every package manifest.** Without it
  `verbatimModuleSyntax` raises `TS1287` against ESM syntax. ESM only: no CommonJS
  output, no second tsconfig per package.
- **No file over 500 lines.** `max-lines` in `.oxlintrc.json` is an error, so
  `lint:check` fails on the 501st line, tests included. Split before you reach it.
- **Standard TC39 decorators only.** The root tsconfig deliberately does not set
  `experimentalDecorators` or `emitDecoratorMetadata`, and `reflect-metadata` and
  `tsyringe` are not dependencies. There are no parameter decorators in the TC39
  proposal, so `@Inject()` does not exist and never will. The one carve-out is
  `tools/bench/servers/nest/`, which sets both flags because the NestJS benchmark
  subject has to run NestJS's real programming model. It has its own tsconfig, it
  is excluded from every other project, and the subject registry reaches it by
  string path so no compiler crosses the boundary.
- **No ESLint and no Biome.** The linter is oxlint (`.oxlintrc.json`) and the
  formatter is oxfmt (`.oxfmtrc.json`). Repo-local rules live in
  `scripts/oxlint-plugin.js`, which is the one deliberately-not-TypeScript file in
  the repo: oxlint loads a JS plugin by spawning Node rather than Bun, so a `.ts`
  file there dies with `ERR_UNKNOWN_FILE_EXTENSION`. `@ts-check` plus JSDoc keeps it
  typed.
- **No section-divider comments.** If a file needs sections, it needs to be more
  than one file.
- TypeScript is `strict`, plus `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`, `noImplicitOverride` and
  `noPropertyAccessFromIndexSignature`. `verbatimModuleSyntax` is on, so type-only
  imports need `import type`.

## Testing

The runner is `bun test`. Every package has a `test` script (`bun test --bail`) and
a `test:cov` script.

```bash
bun run test                              # every workspace
bun test ./packages/http                  # one package
bun run --filter '@dunx/example-full' test
```

**A reported bug gets a failing test first.** Write the test that reproduces the
issue, watch it fail, then fix it, then watch it pass. A PR that fixes a bug
without a test that would have caught it is not finished, and the test is the part
a reviewer reads first.

New behaviour needs tests too. Coverage is tracked per package and published; if
your change moves a package's number down noticeably, expect to be asked about it.

## Measurement culture

This is the part of the repo most worth understanding, and it is not decoration.

**Claims get measured, not asserted.** "Faster", "cheaper", "smaller" are
hypotheses until there is a number attached, and the number has to come from a run
anyone can repeat. If your PR claims a speedup, show the numbers: the command you
ran, the machine, and the before and after.

`tools/bench` is built so this is easy and so it cannot flatter dunx. It verifies
that every subject returns the same status, the same body bytes and the same media
type before it measures anything, spawns a fresh process per subject and scenario,
warms up, then reports the **median across runs together with the standard
deviation**, never a single run. It records the machine and every subject's
version. Its README has a "Known methodology gaps" section, and a section titled
"What these say, including where dunx loses". A result inside the standard
deviation is read as "no measurable difference", not as a win.

```bash
bun run --filter '@dunx/bench' setup    # optional: fetches the oha load generator
bun run --filter '@dunx/bench' start    # the framework comparison
bun run --filter '@dunx/bench' start --help
```

**`docs/ARCHITECTURE.md` records what was tried and rejected, along with the
measurement that decided it.** That is what keeps the same argument from being had
twice. Read the relevant section before proposing a design change in that area, and
if you reverse a recorded decision, re-measure and update the record rather than
quietly replacing it. There is precedent for reversal: `tools/docs` was moved off
Vite onto `Bun.build` for build speed, then moved back onto Vite once a re-measure
showed both halves of the original argument had stopped being true.

If an open question needs a real answer before an API can be fixed, write a small
probe against real Bun, and put what it found in ARCHITECTURE.md or
`docs/bun-apis.md`.

## Commits, versioning and releases

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope)?: description
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `test`, `style`, `refactor`, `perf`,
`build`, `ci`, `revert`, `security`, `sync`.

The type drives the version bump: `feat:` is a minor, `fix:` and the rest are a
patch, and a `!` marks a breaking change and a major. Preview what your commits
would do with `bun run version:dry-run`.

Do not add a `Co-Authored-By` trailer or any other attribution trailer. The commit
message describes the change; who or what typed it is not part of the record.

Releases are automatic. On push to `main`, CI runs the full check set, then
`bun run version` bumps and publishes via npm trusted publishing. Nothing to run by
hand.

### Lockstep versioning

**Every `@dunx/*` package shares one version and ships together**, including the
ones a given commit did not touch. Change detection decides _whether_ to release,
never _what_ to release.

This is a correctness requirement rather than tidiness. The publish path rewrites
each `workspace:*` range to `^<version>` (`resolveWorkspaceRange` in
`scripts/workspace-ranges.ts`, shared by `version.ts` and `first-publish.ts`). With
independent versions, `@dunx/http@0.2.0` would name `@dunx/core@^0.1.0` while a later
`@dunx/infra@0.3.0` named `@dunx/core@^0.2.0`, and an app using both would install
**two copies of `@dunx/core`**. In this container a DI token _is_ a class object,
so two copies means two distinct `Logger` classes and `app.get(Logger)` silently
missing the binding another package registered. `Symbol.for('dunx.deps')` survives
duplicate copies on purpose; class identity cannot. The caret does not save it
either: pre-1.0, `^0.1.0` excludes `0.2.0`. What it does do is stop an **exact** peer
pin from failing an install on a one-patch skew, which is why the published range is
a caret and the versioning is still lockstep.

The cost is that an untouched package still gets a version bump. For a pre-1.0
framework whose packages move together, that is a feature: one number answers
"which versions work together".

## Adding a package or an example

There is a checklist for this, and it is more exact than this page can be: the
`/new-package` skill in `.claude/skills/new-package/`. Read it whether or not you
use Claude Code. `packages/core` is the reference shape to copy from, and
`scripts/manifests.test.ts` will fail on a manifest that would not survive npm
publish unaltered: a `bin` path with a leading `./`, a `repository.url` npm would
normalise, or an internal dependency not pinned to `workspace:*`.

Two things worth knowing up front.

A public subpath export is a build change. `scripts/build-package.ts` derives
entrypoints from `exports` and `bin`, so adding the `exports` key **is** how you add
the entrypoint, and `bun run build` should then produce the file in `dist/`.

An example must be named **`@dunx/example-<dir>`**. CI reaches every example through
`bun run --filter '@dunx/example-*'`, so an off-pattern name is an example that
silently stops being checked. It also needs a `bunfig.toml` supplying the transform
preload under both the root and `[test]`, a `tsconfig.json` extending the root, a
`typecheck` script, and a `test` script with at least one test in it, because
`--filter` skips workspaces that lack the script and does not say so.

Before adding a fifth example, read the Phase 1 section of ARCHITECTURE.md, which
records which candidates were already rejected. Per-package examples were tried and
reverted, and that reversal holds.

## Sending the pull request

1. Branch off `main`.
2. Make the change, with a test.
3. Run `bun run build`, `bun run lint:check`, `bun run format:check`,
   `bun run typecheck` and `bun run test:cov`.
4. Write conventional commits.
5. Open the PR and fill in the template: what changed, why, and any numbers.

Small and focused beats large and comprehensive. If a change turns out to need a
design decision, open an issue first and point at the ARCHITECTURE.md section it
touches, so the discussion happens before the code does.

## License

By contributing you agree that your contributions are licensed under the
[MIT License](LICENSE).
