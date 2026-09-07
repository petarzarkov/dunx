# Functional to OOP across packages/, tools/ and infra

Measured 2026-09-07 against 08398ef (3.3.2). The question asked was how hard a
functional-to-OOP conversion would be and what it buys. The short answer is that
the premise is mostly already satisfied, the residue is 37 files, and one CI gate
decides whether the conversion is cheap or impossible.

## What is actually functional

169 class exports against 178 unique public function-shaped exports, so the
surface looks half functional by name count. It is not, because 98 of those 178
are in shapes that resist or forbid conversion:

| Shape                                                                | Count | Convertible                                          |
| -------------------------------------------------------------------- | ----- | ---------------------------------------------------- |
| Decorators (`Module`, `Controller`, `Cron`, `ApiDoc`, ...)           | 16    | No. A decorator is called as a function              |
| Type guards and predicates (`isCtor`, `isPublic`, `supportsTz`, ...) | 22    | Already Rule 3's stated exception                    |
| DI primitives (`provide`, `token`, `inject`, `describeToken`)        | 9     | Documented API; `describeToken` is named in the rule |
| Marker read/write pairs (`markRoute`/`routeMetaOf`, ...)             | 21    | Yes, and this is the best target                     |
| Traversal and discovery (`providersOf`, `discoverJobs`, ...)         | 17    | Yes                                                  |
| Factories returning an instance (`httpClient`, `createTestApp`, ...) | 13    | Thin; the class already exists behind them           |

Of 93 class-free source files over 25 lines, classification puts roughly 15 in
barrels or type-only files, 4 in decorators, 30 in the sanctioned pure-helper
exception and 5 in glue over a class that lives elsewhere. The real target is
**37 files, 6,293 lines of source, plus 3,689 lines of co-located test in 16 of
them.**

Two sub-buckets in that 37:

**Hidden module state (5 files).** `core/src/di/inject.ts:14` (`let current`, the
ambient injector swapped on every construction), `infra/src/db/transaction.ts:46`
(a `WeakMap` of per-handle depth and queue), `infra/src/schedule/capability.ts:18`
(`let cached`, a memo no test can reset), `openapi/src/convert.ts:45`
(`let loading`, the memoised zod import), `tools/create-app/src/cli.ts:44-61`
(parsed argv and a live `Style` at import time).

**Threaded value or configured factory (32 files).** The clearest are
`infra/src/pagination/keyset.ts`, `infra/src/db/transaction.ts` and
`infra/src/db/seed.ts` (all thread the drizzle handle), `http/src/ws/adapter.ts`
(12 private helpers threading `socket`), `http/src/server/routes.ts`
(`(middleware, onError, cors, resolve)` repeated positionally),
`openapi/src/operations.ts` and `convert.ts` (both thread `SchemaStore`),
`tools/mcp/src/protocol.ts` and `tools.ts` (thread `tools`/`serverInfo`/`root`).

## The gap in core DI

`Injector` is a class with private fields (`core/src/di/injector.ts:37`), but the
graph it resolves against is not: `Scope` and `ScopeGraph` are interfaces holding
Maps (`di/scope.ts:36,49`), produced by the free function `buildScopes`
(`di/scope.ts:219`), and `unresolvableMessage` (`di/scope.ts:304`) takes them back
as arguments. `di/module.ts` is the same shape, six readers over `ResolvedModule`.
Resolution behaviour is OOP; the data structure it resolves over is a
free-function pipeline over plain records.

## Gains

- **Rule 2, not Rule 3, is the strongest argument.** Four files repeat the same
  symbol-keyed mark/read pair: `http/src/route/marker.ts:60,64`,
  `http/src/ws/marker.ts:37,41`, `infra/src/queue/marker.ts:31,35`,
  `infra/src/schedule/marker.ts:69,73`. One `Marker<TMeta>` class taking the
  symbol as its constructor argument replaces all four.
- **State that cannot currently be tested becomes a field.**
  `schedule/capability.ts`'s memo has no reset path, so a suite cannot exercise
  both branches of the `Bun.cron` timezone probe.
- **Two real inefficiencies.** `dashboard/src/board.ts:225` calls `compile(routes)`
  fresh inside `matchBoard` (`board.ts:307`), re-splitting and re-sorting
  bull-board's route patterns on every non-exact-match request; the compiled table
  is exactly what a class would hold once. `infra/src/pagination/keyset.ts` takes
  the db handle through a call argument on every request from a service that
  already holds `this.db` (`examples/full/src/database/ledger.service.ts:54`).
- **`transform/src/deps.ts` is free of runtime cost.** It is build-time only, so a
  `DepsTransform` class holding source plus parse result ships no bytes to a
  consumer. `plugin.ts` is not a constraint: `BunPlugin` is a structural interface,
  so a class instance satisfies it at all three call sites.

## Downsides, in order of how binding they are

**1. The coverage gate, and it is the one that decides this.** `bun run ci`
enforces 90% on functions as well as lines. Headroom before that fails, in extra
uncovered functions:

| Package   | funcs   | fn%    | Headroom |
| --------- | ------- | ------ | -------- |
| testing   | 44/47   | 93.62  | **1**    |
| core      | 178/195 | 91.28  | **2**    |
| transform | 26/26   | 100.00 | 2        |
| auth      | 47/49   | 95.92  | 3        |
| mcp       | 54/56   | 96.43  | 4        |
| openapi   | 120/127 | 94.49  | 6        |
| http      | 553/590 | 93.73  | 24       |
| infra     | 557/589 | 94.57  | 29       |

CLAUDE.md already records that a class with no explicit constructor contributes
one unreachable function to the denominator, and that core is at its measurable
ceiling. So the tempting conversion shape - a static-method namespace class - is
precisely the shape the gate punishes, and core absorbs two of them before
`bun run ci` fails. Converting the graph/module/scope trio that way fails
immediately. Classes with a real constructor that tests instantiate cost nothing.

**2. Tree-shaking granularity, measured.** A consumer importing 1 of 8 free
functions builds to 64 B raw / 84 B gzip; the same via a class with 8 methods is
404 B raw / 289 B gzip, because the 7 unused methods cannot be dropped. On real
built code, `core/dist` costs a consumer 325 B gzip for the first of `graph.ts`'s
three functions and only 166 B more for the other two, so collapsing them into one
`Graph` class costs a single-method consumer about 166 B gzip. Small, and in the
direction ARCHITECTURE.md's `splitting` note already cares about.

**3. Breaking changes on a published 3.3.2.** Of the conversion candidates, 13
appear in `examples/` and 15 in `docs/guide/`. `transaction` and `transactionSync`
alone have 14 example call sites across 9 directories, and `paginate`/`pageOf`/
`parsePageOptions`/`runSeeds` reach the vendored `create-app` template at
`tools/create-app/templates/features/database`, so Rule 4 plus
`bun run sync:templates` ride along. `@dunx/infra/pagination` is a fully
function-based public subpath (five free functions, two error classes).

**4. `max-lines` is an error at 500.** Seven source files are already at or over
400: `create-app/src/generate.ts` (490), `http/src/client/service.ts` (489),
`infra/src/queue/worker.ts` (479), `http/src/server/request-logging.ts` (474),
`http/src/ws/adapter.ts` (471), `infra/src/redis/client.ts` (461),
`create-app/src/features.ts` (452). `ws/adapter.ts` is on the target list and
wrapping it in a class body pushes it over, forcing a split in the same change.

**5. The self-bind trap.** CLAUDE.md: an unbound class self-binds into whichever
scope asks first, so a second consumer is a boot error. Converting internal
helpers into injectable classes means a module has to bind each one.

**6. No performance argument either way.** Closure-from-factory against a class
method on a hot per-request path, 20M calls, three rounds: 1.782 / 4.116 / 3.467
ns per call for the closure against 1.946 / 3.851 / 4.210 for the method. The
cross-round variance exceeds the difference between shapes.

## Recommendation

A sweep is the wrong shape: 47 of 178 public function exports cannot or should not
move, so "fully OOP" is unreachable by design and the coverage gate blocks the
naive form. Three tiers instead.

**Tier 1, no semver cost and real wins.** One `Marker<TMeta>` class replacing four
duplicate pairs (the Rule 2 finding). `infra/src/files/path.ts`, which no subpath
exports, so the `root`-threading pair is free to fix. `schedule/capability.ts`.
The `board.ts` compile caching. `transform/src/deps.ts`, build-time only. Each
gets a real constructor and a test that instantiates it, so coverage headroom is
untouched.

**Tier 2, worth a major when one is due.** `pagination` to `KeysetPaginator(db)`,
`db/transaction.ts` to `Transactions(db)`, `testing/src/http2.ts` to a class.
These are the three where the threaded value is genuinely a constructor argument
and consumers feel the improvement.

**Tier 3, leave alone.** Decorators, predicates, the DI primitives, barrels, and
core's `graph`/`scope`/`module` trio. Core has two functions of headroom and is at
its measurable ceiling.

## Incidental finding

`infra/src/queue/discover.ts:66` embedded a literal NUL byte in a dedupe key
template. `file` reported the source as `data`, so `grep`, `ripgrep` and `git`
all treated it as binary: every commit that ever touched the file rendered as
`Bin N -> M bytes`, and repo-wide searches skipped it without reporting
anything.

Fixed independently of any of the above, and the first attempt was wrong in a
way worth recording. Escaping the byte kept a joined `(queue, name)` key, and
the argument for keeping NUL was that it cannot occur in a queue or job name.
`JobMeta.queue` and `JobMeta.name` are unvalidated `string`s, so it can: review
pointed this out, and `("a", "b<NUL>c")` and `("a<NUL>b", "c")` both key as
`a<NUL>b<NUL>c`, which rejects two distinct handlers as one at boot. No choice
of separator character fixes that. The key is now
`JSON.stringify([job.queue, job.name])`, which is injective for any pair of
strings and leaves no control byte in the source at all.
`scripts/no-control-chars.test.ts` guards the C0 range across every tracked and
untracked file.
