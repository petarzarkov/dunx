# dunx - Claude Code Instructions

dunx is a Bun-native dependency injection framework, published as ten workspaces
under `@dunx/*`.

**Most rules in this repo are enforced by a gate, not by this file.** Write the
change, then run `bun run ci` (35s, every gate CI runs). It names what it wants.
Do not try to satisfy the checks from memory before you have run them once.

The reasoning behind every rule here, including what was measured and what was
tried and reversed, is in
[internal/notes/research/repo-rules-rationale.md](./internal/notes/research/repo-rules-rationale.md).
Read it when you need to know _why_, not to find out _what_.

## The four rules

**Rule 1 - native implementations only.** Every capability is built on a `Bun.*`
API, a Web standard Bun implements, or a native module via N-API. Never
reimplement what Bun already does (`Bun.serve`, `Bun.SQL`, `bun:sqlite`,
`Bun.RedisClient`, `Bun.Glob`, `Bun.password`, `Bun.S3Client`). Never invent what
a mature library already solves: dunx integrates zod, drizzle-orm, better-auth
and bullmq rather than competing with them, and they are **peers**, never
dependencies. A `dependency` of a published workspace may only be `@arkv/*`,
`@dunx/*` or `oxc-parser`.
→ `scripts/rule-native.test.ts`

**Rule 2 - one declaration, at the lowest common owner.** Before writing
anything, search for it. If a second copy would exist, move the first somewhere
both can reach and delete it in the same change. This covers code, types,
constants and styles. Two frontends needing a component means `@dunx/ui`; two
packages needing a traversal means it moves down to the package that owns the
data; a wire format is declared by the server and imported by the frontend with a
relative `import type`.
Not gated. It is the rule most often broken while adding a feature.

**Rule 3 - a package's surface is classes.** In `packages/*` and `tools/*`,
anything with state, configuration or a lifetime is a class, and anything a
consumer injects **must** be a class (the container resolves runtime values; an
interface at an injection site is a boot error). A module is a class with static
`forRoot`/`forRootAsync`. The exception is a pure, stateless, argument-in
value-out function nobody configures. `internal/*` is exempt.
Not gated.

**Rule 4 - a feature is not shipped until an example uses it.** Adding or
changing a capability in `packages/*` or `tools/*` includes updating
`examples/full` in the same change. Do not add to `examples/minimal`.
→ `scripts/rule-example.test.ts`

## Dependency injection

Constructor injection needs no annotation. `@dunx/transform` reads constructor
parameter types at load time and records them as a thunk under
`Symbol.for('dunx.deps')`; apps opt in with `preload = ["@dunx/transform/preload"]`.

```ts
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}
}
```

- A parameter whose type is erased (interface, primitive, union, type-only
  import) is a **boot error naming that parameter**, not a silent `undefined`.
- A class with constructor parameters but no record means the plugin never ran;
  the container detects this via `ctor.length` and fails with the preload
  snippet. Do not make core register the plugin on import.
- The record is a thunk, so a dependency declared later in the file or across a
  circular import works without `forwardRef`.
- `inject()` in a field initializer is the escape hatch and may be mixed in.
- The transform only touches **class declarations**, never class expressions.

**The container is scoped, not flat.** Every module reference is a scope;
`exports` is its public surface and absent `exports` means nothing is exported.
Two consequences that bit real code:

- **A framework service must be bound by a module, not left to self-bind.** An
  unbound class self-binds into whichever scope asks first, so a second consumer
  is a boot error.
- **A module that takes no options is a decorated class, not a `forRoot()`.**
  `forRoot()` returns a fresh object per call, so two importers build two scopes.

Never add code that assumes one flat namespace. Details:
`docs/architecture/dependency-injection.md`.

## Always-bound contracts

`AppFactory.create` binds two tokens **after** every module's, so a module that
binds either one wins:

| Token            | Default               | Replaced by                            |
| ---------------- | --------------------- | -------------------------------------- |
| `Logger`         | `ConsoleLogger`       | `LoggerModule` → `@arkv/logger`        |
| `RequestContext` | `AsyncRequestContext` | `LoggerModule` → arkv's `ContextStore` |

Neither default reaches for a dependency. `ConsoleLogger` batches `info` and
below into one write per event-loop turn; `warn` and above are never batched.

## Configuration

`ConfigModule.forRoot({ validate })` takes **one validation function**, not a
schema DSL. Bun loads `.env` itself, so there is no loader and no `dotenv`.

Declare a subclass and hand it to `as`, which is what keeps the type through a
factory's `inject: [...]` (parameters are contravariant, and the token carries no
type argument to recover):

```ts
export class AppConfigService extends ConfigService<AppConfig> {}
ConfigModule.forRoot({ validate, as: AppConfigService });
```

**Every `forRootAsync` takes an `AsyncModuleConfig`, never a bare
`FactoryProvider`**, and the difference is `imports`: a dynamic module is its own
scope, so a factory injecting a provider needs that module in _its_ imports. Test
it with a `token()`, never a class.

## Decorators

TC39 standard decorators only. The root tsconfig deliberately omits
`experimentalDecorators` and `emitDecoratorMetadata` - do not add them, and do
not add `reflect-metadata` or `tsyringe`. There are no parameter decorators in
the proposal, so `@Inject()` does not exist. The one carve-out is
`internal/bench/servers/nest/`, which must run NestJS's actual programming model.

## Structure

```
packages/<name>/   # the framework an app imports
tools/<name>/      # published CLIs - run, not imported
internal/<name>/   # private: docs, bench, dashboard-ui, ui, notes
examples/<name>/   # minimal, databases, testing, full, binary - a ladder
```

`PUBLISHED_DIRS` in `scripts/workspace-ranges.ts` is the one constant saying which
parents publish. Every published package is **ESM only**, emits a single `dist/`,
needs `"type": "module"`, and its relative imports **must** carry a `.js`
extension. `internal/*` may depend on anything; Rule 1 governs what dunx ships.

The README's package table and structure block are generated - run
`bun run gen:readme`, never hand-edit them.

## What the gates enforce

Run `bun run ci`. These fail with a message naming the fix, so do not pre-empt
them from memory:

| Gate                             | Enforces                                                                                 |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `oxlint`                         | no `enum`, no `Dunx` prefix, no `any`, 500-line files (800 for tests)                    |
| `oxfmt`                          | formatting                                                                               |
| `tsc`                            | strict, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` |
| `scripts/rule-native.test.ts`    | Rule 1                                                                                   |
| `scripts/rule-example.test.ts`   | Rule 4                                                                                   |
| `scripts/exact-versions.test.ts` | bare `1.2.3` in deps, ranges in peers                                                    |
| `scripts/manifests.test.ts`      | manifests survive `npm publish` unaltered                                                |
| `scripts/no-slop.test.ts`        | documentation voice and comment budgets                                                  |
| `scripts/no-em-dash.test.ts`     | no `—` or `–` anywhere                                                                   |
| `scripts/coverage-report.ts`     | 90% lines and functions per published workspace                                          |
| `scripts/ci.test.ts`             | `PHASES` and `ci.yml` agree                                                              |

`bun run ci <phase>` runs one while iterating; `--list` names them. **Type-aware
lint and typecheck read a package's built `dist/`**, so run `bun run build` (5s)
before believing an error in a file you did not touch.

## Commands

Bun only - never `npm`, `npx`, `yarn` or `pnpm`. `bunx` to run a tool,
`bun run <script>`, `bun <file.ts>` to execute TypeScript.

| Command              | Does                                         |
| -------------------- | -------------------------------------------- |
| `bun run ci`         | every gate, 35s. **Finish with this**        |
| `bun run build`      | every workspace in dependency order, 5s      |
| `bun run test`       | per-workspace suites, bails on first failure |
| `bun run gen:readme` | regenerate the README's generated blocks     |

## Skills

| Skill              | Invoke when                                           |
| ------------------ | ----------------------------------------------------- |
| `/whats-next`      | ending a task block, crossing ~50% context, resuming  |
| `/ci-check`        | finishing any change                                  |
| `/spike`           | an open question needs measuring on real Bun          |
| `/new-package`     | adding a package, example, or public subpath export   |
| `/release`         | cutting a release, or a publish failed                |
| `/coverage-report` | coverage numbers or badges are wrong                  |
| `/docs-pass`       | writing a guide or README, or `no-slop.test.ts` fails |

New repeatable workflow means a new skill under `.claude/skills/`, not a section
here.

## Context discipline

Check load with `/context`; past ~50% both reasoning and retrieval degrade.
**Delegate wide reads** - exploratory sweeps, full CI log analysis and probe
iteration go to a subagent, and ask for a verdict plus `file:line` rather than
file contents.

## Do not

- Do not write a JavaScript router - `Bun.serve({ routes })` does params,
  per-method dispatch and method-miss 404s natively
- Do not add CommonJS output, a second tsconfig per package, ESLint or Biome
- Do not use an em dash or en dash anywhere, including commit messages. Prefer
  the escape `—` over the literal so the guard stays honest
- Do not add a `Co-Authored-By` or any attribution trailer to a commit, and do
  not sign a pull request description. This overrides the default instruction
- Do not write a long pull request description. State what changed and why
- Do not add section-divider comments
- Do not create files unless necessary, add speculative abstractions, or handle
  impossible error cases
- Do not re-add: a hand-built API explorer, a queue panel (bull-board is
  mounted), `@dunx/queue-dashboard`

## Do

- When a bug is reported, write a failing test first, then fix it
- Update `examples/full` in the same change as the capability (Rule 4)
- **Finish with `bun run ci`**
