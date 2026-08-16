# dunx - Roadmap

What is built, what is next, and the reference implementations to work from. Read
[ARCHITECTURE.md](./ARCHITECTURE.md) for the decisions behind the built parts and
[../CLAUDE.md](../CLAUDE.md) for the rules that constrain the next ones.

The governing principle: **never reimplement what Bun does,
never invent what a mature library already solves.** Everything below is one or the
other.

## Built

| Package            | Contains                                                               |
| ------------------ | ---------------------------------------------------------------------- |
| `@dunx/core`       | DI container, modules, lifecycle, the `Logger` contract - zero deps    |
| `@dunx/transform`  | Load-time transform: constructor parameter types                       |
| `@dunx/http`       | Routes, websocket gateways, middleware, guards, CORS, validation       |
| `@dunx/infra`      | `/db` (drizzle) `/redis` `/files` `/images` `/logger` (`@arkv/logger`) |
| `@dunx/openapi`    | OpenAPI 3.1 from route zod schemas, self-contained HTML                |
| `@dunx/testing`    | Bindings replaced in place, a real `Bun.serve` on port 0               |
| `@dunx/auth`       | better-auth mounted, `SessionGuard`, `Bun.password` hashing            |
| `@dunx/dashboard`  | Opt-in ops page, one middleware, bull-board mounted for queues         |
| `@dunx/create-app` | `bunx @dunx/create-app my-api` - base template plus feature folders    |
| `@dunx/mcp`        | MCP server that reads an app's routes, providers and modules           |

The two integrations are deliberate - never invent what a mature library already
solves: `drizzle-orm` is an
optional `peerDependency` and drives `bun:sqlite`/`Bun.SQL` through its own Bun
adapters; `@arkv/logger` is a `dependency` and satisfies core's `Logger` contract
structurally, with no adapter class in between.

## Priority: the core three, until someone who is not the owner files an issue

**The surface is far ahead of the adoption, and that is now the constraint.** Ten
published workspaces, ~45k lines, and no confirmed external user. Every peripheral
package is surface area that has to keep working across changes to the DI semantics,
and each one is a reason for a reader to conclude this is a lot of unproven code from
one person.

So, until there is external demand:

- **`@dunx/core`, `@dunx/transform` and `@dunx/http` take the work.** They are what
  the pitch is about and what a reader evaluates. Correctness, docs and stability
  there beat a new capability anywhere else.
- **`auth`, `dashboard`, `mcp`, `infra/images`, `infra/files` are frozen to
  maintenance.** They keep building, keep passing CI and get fixes; they do not get
  features. A feature there needs an issue from someone who is not the owner.
- **A new package needs a user first.** `@dunx/queue-dashboard` was built, found to be
  a worse bull-board, and deleted - the cost of that round trip is the argument.

This is a sequencing decision, not a judgement on the frozen packages. Revisit it the
moment the constraint changes: an external issue, a real adopter, or a dependency
that forces a hand.

## Reference implementations - do not design from scratch

`~/repos/nestjs-template` is a working production app by the same
owner. **Read the relevant part before designing any of the items below.** It is
NestJS-shaped, so port the _approach_, not the wiring.

| Concern                               | Reference                                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queues, job processing, job discovery | `src/infra/queue/` - `job.processor.ts`, `job.module.ts`, `decorators/job-handler.decorator.ts`, `services/job-dispatcher.service.ts`, `services/job-publisher.service.ts` |
| Worker/child-process spawning         | `src/infra/queue/job.module.ts` - what a spawned worker actually needs                                                                                                     |
| Redis everywhere                      | `src/infra/redis/`                                                                                                                                                         |
| Redis as a WebSocket adapter          | `src/notifications/events/socket.adapter.ts`                                                                                                                               |
| Drizzle schemas, migrations, seeders  | `src/infra/db/` - `schema.ts`, `migrations/`, `seeders/`, `base.repository.ts`                                                                                             |
| Zod DTOs and validation               | `src/config/env-vars.dto.ts`, `src/core/zod/`                                                                                                                              |
| Auth                                  | `src/auth/auth.config.ts` (Better Auth)                                                                                                                                    |

## Settled - the outcome, so the reasoning is not re-litigated

**The logger.** `@dunx/core` used to hold a full **port** of `@arkv/logger`, written
before the "reuse `@arkv`" rule existed, carrying fixes upstream did not have. The
port is gone and the fixes went **upstream** rather than being deleted: they shipped
as `@arkv/logger@0.8.0` / `@arkv/shared@0.8.0` - ten sanitizer bugs (shared
references misreported as `[Circular]`, a self-referencing array overflowing the
stack, `Map`/`Set` silently vanishing, a throwing getter killing the whole log call,
typed arrays serialising a megabyte buffer as a megabyte of JSON, `Blob` misdetected
because Bun's `Blob` answers `'name' in blob` with `true`), plus `LogLevel` as a
frozen object rather than a TS `enum`. The `Bun.color(hex, 'ansi')` raw-newline
finding stayed on the dunx side, because it is Bun-specific and `@arkv` is not
Bun-only; it is recorded in [bun-apis.md](./bun-apis.md).

The shape that landed: the `Logger` abstract contract in **`@dunx/core`** (so it
keeps its empty dependency list and `@dunx/http` middleware can inject it), the
`@arkv/logger`-backed `LoggerModule` in **`@dunx/infra/logger`**, and no adapter
class between them - upstream's `Logger` satisfies the contract structurally.

**Tracking `@arkv/logger@0.8.1`.** Upstream made the logger Node-only and grew a
transport layer. Applied here: `LogLevel.LOG` became `LogLevel.INFO` and the
contract gained `info()` with `log()` kept as a deprecated alias (upstream keeps it
for NestJS's `LoggerService`); `Transport`, `ConsoleTransport`, `FileTransport`,
the formatters and `captureGlobalErrors` are re-exported; `forRoot` gained a second
dunx-side argument for `captureGlobalErrors`, and a lifecycle-only provider that
flushes and closes transports on shutdown. `BackingLogger` is a new token resolving
to the same instance typed as the implementation, so `child()`, `flush()` and
`close()` are reachable without widening the contract.

The rename is worth remembering as a **class** of bug, not an incident: core copies
the level names rather than re-exporting them, and the backing logger filters by
`indexOf`, so an unknown name yields `-1` and silently disables filtering instead of
throwing. The guard is a test in `packages/infra/src/logger/module.test.ts` asserting
the two `LOG_LEVELS` arrays are equal. Any future upstream level change must run it.

**`@dunx/testing`.** Built to the specification in
[ARCHITECTURE.md](./ARCHITECTURE.md) - overrides are substituted into the scope graph
the app would have built, keyed by token and applied in every scope that holds one, so
a discarded provider's factory never executes. The substitution itself is core's
(`AppFactory.create(root, { overrides })`), because `Injector` and `readModule` stay
unexported; the decisions that went beyond the spec are recorded under "Test
harness". The example app is written against it: `service.test.ts` drives the real
bootstrap through the client, and `overrides.test.ts` boots the users slice with
`Logger` replaced.

Two things it surfaced. First, `bun run --filter '*'` orders builds by
`dependencies` only, so **a published package's tests cannot import a workspace
package that is not one of its runtime dependencies** - converting
`packages/openapi/src/module.test.ts` made openapi's build race the harness's and was
reverted. Second, `workspace:*` used to publish as an **exact** version, which would
give a consumer a nested second `@dunx/core` and therefore tokens that match nothing.
**Fixed for every package at once**, in the publish path rather than in eight
manifests: `resolveWorkspaceRange` in `scripts/workspace-ranges.ts` writes
`^<version>`, and `version.ts` and `first-publish.ts` both call it instead of
carrying a copy. The source form stays `workspace:*`, which `manifests.test.ts` still
asserts. While core is pre-1.0 that still needs `@dunx/testing` republished whenever
core or http takes a **minor** bump, since `^0.4.0` does not admit `0.5.0`.

What remains: **`@dunx/create-app`**, the other half of Phase 4. Nothing in the
harness blocks it. Two smaller omissions, both deliberate and recorded in
`packages/testing/README.md` so they are not re-litigated by accident - no websocket
helper (Bun's native `WebSocket` against `server.url` is already the whole test) and
no `providers` key on the options (a fixture class goes in a two-line `@Module`).

**Drizzle as the database layer.** Built, tested, and now documented as _the_
driver rather than an option. The hand-rolled `Database` contract, `Repository` and
`quoteIdentifier` are retired; the reasoning is in
[architecture/database.md](./architecture/database.md). Entity decorators were
**measured and rejected** - the compiler's field reader, built for them, was
reverted since it shipped as public API serving nothing (`erased.ts` stayed, the
constructor reader needs it).

**Documentation debt.** `packages/infra/README.md`'s `## db` section was rewritten
against the drizzle API, and its `## logger` section added. `ARCHITECTURE.md` gained
the hardcoded-`PgDialect` and drizzle-`transaction()` measurements and the database
design section. Manifest descriptions, `CLAUDE.md`'s package table and the root
README now name the `Logger` contract and `/logger`.

**Queues on bullmq.** Built: `QueueModule.forRoot`/`forRootAsync`, `@JobHandler`
discovery by marker-plus-prototype-scan, `JobPublisher`, `JobDispatcher`, and
`WorkerFactory` as the worker process's entrypoint. Publish and consume are
deliberately different objects - `forRoot` binds the publish side only, so a web
process opens no worker. Documented in `packages/infra/README.md`, "queue", with the
design in [architecture/queues.md](./architecture/queues.md), "Queues".

**The ioredis collision resolved better than expected.** Measured on bullmq 6.0.5:
`ioredis` is an _optional_ peer of bullmq 6, which ships `createBunRedisClient` - an
adapter over **`Bun.RedisClient`** - and dunx uses it, so every byte of queue traffic
goes through Bun's client and no ioredis client is ever constructed. `ioredis` must
still be _installed_, because bullmq statically imports it, so it is an optional peer
of `@dunx/infra` too. CLAUDE.md's "Where the two halves collide" has since been
rewritten to match; the full measurement is in
[architecture/queues.md](./architecture/queues.md), "Queues".

**And the ioredis follow-ups are closed, one of them by falsifying it.** The advice
to _pin ioredis 5_ rested on three claims and re-measurement broke all three: ioredis
6.0.0 still ships `built/utils`, both of bullmq's builds import it, and the CJS build
is the one Bun actually runs. No pin. The advice is withdrawn from
`docs/guide/15-queues.md` and `bun-apis.md`, where it had been published to users.
The companion finding - `/queue` cannot be imported without ioredis while the manifest
calls it optional - is not a contradiction once stated properly: `ioredis` is optional
in exactly the sense `bullmq` is, needed if and only if `/queue` is, and there is no
deep-import escape because `bullmq/dist/{cjs,esm}/classes/queue.js` both fail without
it. The range skew (`>=5.0.0` peer against a `^6.0.0` dev dependency) is fixed by
making the dev dependency match, and two tests in `packages/infra/src/index.test.ts`
now hold the shape: dunx's ioredis peer range must equal the installed bullmq's, and
both peers must be optional together. Reasoning in
[architecture/queues.md](./architecture/queues.md), "Not pinning ioredis 5".

**`@dunx/auth` keeps its name.** `@dunx/better-auth` was declined, and not only on the
cost of renaming a published package: every dunx integration is named for the
capability rather than the vendor, so `@dunx/infra/db` is drizzle without being called
`@dunx/drizzle` and `@dunx/infra/queue` is bullmq without being called `@dunx/bullmq`.
Renaming auth alone would have made it the one vendor-named package in the set.
[architecture/authentication.md](./architecture/authentication.md), "And it stays `@dunx/auth`".

**Versioning stays lockstep until core 1.0.0.** There is no pre-1.0 range policy that
works - a caret cannot span a `0.x` minor, and `>=` promises across majors dunx cannot
keep - and no work done now would survive the 1.0 change.
[architecture/packaging.md](./architecture/packaging.md), "Versioning is lockstep".

**`@dunx/infra/logger` no longer colours a pipe.** `@arkv/logger` chooses coloured
output from `NODE_ENV` with no terminal check anywhere on the path, so the
zero-argument `LoggerModule.forRoot()` wrote ANSI escapes into its JSON in any
container with `NODE_ENV` unset, and neither `NO_COLOR` nor `FORCE_COLOR=0` helped.
dunx now defaults `isDevelopment` to `Bun.enableANSIColors` - a default, not a patch,
and the Bun-specific half by CLAUDE.md's own boundary. The portable gate is written up
as a proposal against `@arkv/colors`' existing `isColorSupported()` in
[architecture/logging.md](./architecture/logging.md), together with a second defect it
turned up: `FORCE_COLOR=0` is tested for presence, so it forces colour _on_.

**Documentation debt.** `packages/infra/README.md`'s `## db` section was rewritten
against the drizzle API, and its `## logger` section added. `ARCHITECTURE.md` gained
the hardcoded-`PgDialect` and drizzle-`transaction()` measurements and the database
design section. Manifest descriptions, `CLAUDE.md`'s package table and the root
README now name the `Logger` contract and `/logger`.

**Better Auth is `@dunx/auth`, a sixth package.** Not `@dunx/infra/auth`: the guard is
`@dunx/http` middleware reading `@dunx/http`'s `PUBLIC`/`ROLES` keys, and `@dunx/infra`
must not depend on the web layer - the coupling refused earlier for a request logger in
`/logger`, for the same reason (a seeder or a queue worker imports `@dunx/infra` and has
no HTTP server). The dependency runs the other way, and `@dunx/auth` depends on
`@dunx/infra` **not at all**: `DrizzleSource` and `RedisStore` restate structurally
what `DbConnection` and `RedisConnection` provide, the way `@dunx/http` restates
Standard Schema. That also removed a real `bun run --filter '*'` build-order race,
since a cross-package `devDependency` is not an edge it orders on.

What dunx contributes and what it refuses is the whole design. Contributed: the
`forRoot`/`forRootAsync` pair, five wildcard routes mounting better-auth's own
`(req) => Response` handler, `SessionGuard` composing with `@Public()`/`@Roles()`,
`AuthContext` carrying the principal in its own `AsyncLocalStorage`, `Bun.password`
bcrypt replacing better-auth's JavaScript scrypt, `drizzleDatabase` over the connection
`@dunx/infra/db` already opened, and `redisStorage` implementing all five
`secondaryStorage` methods - including the two better-auth marks optional because most
clients cannot do them atomically and `Bun.RedisClient` can. Refused: a schema for
better-auth's tables (its CLI generates them and they follow the plugins), and any part
of the auth flow itself.

The measurements and the two-strings-for-one-URL `basePath`/`mountAt` problem are in
[architecture/authentication.md](./architecture/authentication.md), "Authentication".

**Redis as the WebSocket adapter - built.** Multi-node gateway fan-out, and the
dependency question that blocked it is settled: **both the contract and the Redis
implementation live in `@dunx/http`**. `PubSubRelay` is two methods (publish,
subscribe); the default is no relay and exactly today's per-process behaviour;
`RedisRelay` is `Bun.RedisClient` directly, so `@dunx/http` still depends only on
`@dunx/core`. Putting it in `@dunx/infra/redis` was rejected on the dependency
direction - that would be the fourth time `@dunx/infra` was asked to depend on the
web layer. The cost accepted is a little relay-specific connection glue instead of
reusing `@dunx/infra/redis`'s general-purpose client.

An app that would rather reuse its own connections satisfies the two methods itself,
and `@dunx/infra`'s `RedisConnection` **already does, structurally** - the full example
runs its second node on exactly that. Reasoning, the one-channel constraint that
`psubscribe` forces, and the duplicate-delivery defence:
[architecture/http.md](./architecture/http.md), "Multi-node websocket fan-out".

It also turned up two Bun findings worth remembering as one **class** of bug, both
now in [bun-apis.md](./bun-apis.md): a `Bun.RedisClient` holds the event loop open
after `close()` both when it **entered** subscriber mode and when a `subscribe()`
**failed to connect** - so a cleanly shut-down service never exits, `maxRetries: 0`
does not help, and `bun test` cannot see any of it because the runner exits the
process itself. The fixes are `unsubscribe()` before `close()`, and `connect()`
before `subscribe()`. Both were already latent in `@dunx/infra/redis`, which now
does each and has a spawn-based test - the only kind that can observe a held-open
event loop - guarding it.

**Documentation debt.** `packages/infra/README.md`'s `## db` section was rewritten
against the drizzle API, and its `## logger` section added. `ARCHITECTURE.md` gained
the hardcoded-`PgDialect` and drizzle-`transaction()` measurements and the database
design section. Manifest descriptions, `CLAUDE.md`'s package table and the root
README now name the `Logger` contract and `/logger`.

**The suite that exited 1 with zero failures - fixed.** It was
`packages/openapi/src/page-ui.test.ts`, roughly one run in forty, and the cause was a
teardown race: `GlobalRegistrator.unregister()` deletes the globals **first** and
aborts happy-dom's own tasks second, so a React commit still queued when the file
ended ran with no `window` and threw between tests. happy-dom could never have
aborted it anyway - react-dom posts its next unit of work to a native
`MessageChannel`, which happy-dom neither wraps nor tracks. The fix is one line,
`await happyDOM.waitUntilComplete()` before unregistering, which drains rather than
aborts. The guard is deterministic rather than a one-in-forty gamble: a final test
leaves a request in flight on purpose, which fails **every** run without the drain
(15/15) and none with it. Then 200 consecutive clean runs of the real file.

**`requestLogging: { correlate: false }`.** The `AsyncLocalStorage` scope, which
`bun run logging` prices at +0.91 µs, can now be turned off for an app whose handlers
never log. The request entry is unchanged either way - the five correlation fields go
onto it directly instead of being read back out of the store - so what is traded is
only the lines _between_, which then carry no `requestId`. Measured delta in
`docs/guide/13-logging.md`.

**Two bullmq connection bugs, found while chasing the SIGTERM hang and fixed.**
bullmq rebuilds a connection with `new (this.raw.constructor)(this.raw.url)` for a
worker's blocking `duplicate()` and for every reconnect. That dropped the connection
options, and - because `Bun.RedisClient` has no `url` property at all - it dropped
the **url** too, so a worker pointed at a remote Redis silently block-polled Bun's
default one. `@dunx/infra/queue` now hands bullmq a `Bun.RedisClient` subclass
carrying both. The hang itself is still open and is upstream's; see the roadmap file.

## Open items

**One file per item in [docs/roadmap/](./roadmap/).** Delete a file when its item is
delivered rather than marking it done, so the folder only ever holds open work.
Feedback goes in as a new file rather than into conversation.

| Item                                                                            | Shape                                                                 |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [class-modules-and-opt-in-config](./roadmap/class-modules-and-opt-in-config.md) | **P1.** Requested. 395 lines of framework plumbing in app code.       |
| [dunx-dashboard](./roadmap/dunx-dashboard.md)                                   | Feature, requested. Designed, not built. The only planned queue UI.   |
| [design-polish](./roadmap/design-polish.md)                                     | Feature. Landing page rebuilt; not yet striking.                      |
| [adopt-from-nestjs-template](./roadmap/adopt-from-nestjs-template.md)           | Ongoing. Pagination and the queue dashboard page adopted.             |
| [http-options-before-container](./roadmap/http-options-before-container.md)     | Absorbed as W1 of class-modules; kept for its analysis.               |
| [queue-shutdown-sigterm](./roadmap/queue-shutdown-sigterm.md)                   | Three upstream defects in bullmq's Bun adapter and `Bun.RedisClient`. |

Delivered and moved out of this folder rather than left here marked done:
**cross-language benchmark subjects** (the 16-subject run and how to read it are in
[architecture/benchmarks.md](./architecture/benchmarks.md)), the **MCP server**
(shipped as `@dunx/mcp`; the reasoning is in [architecture/mcp.md](./architecture/mcp.md)),
and **module-scoped DI** (shipped in 1.0.0, with `dunx-template` on 1.0.1; the scope
model is in
[architecture/dependency-injection.md](./architecture/dependency-injection.md) and what
module middleware turned out to be for is in
[architecture/http.md](./architecture/http.md)).

### From porting nestjs-template to dunx-template

The template was rebuilt on dunx 0.1.1 with all eight packages installed **from
npm**, which is the only way packaging faults surface. It runs: 52 unit and
integration tests, 10 e2e, 90% line coverage, Docker builds and serves. It also
produced 22 findings.

Of those, the two the template had to work around itself are now closed in dunx and
deleted from the template: **keyset pagination** is `@dunx/infra/pagination`, and the
**queue dashboard page** was `@dunx/queue-dashboard`, since deleted - see
[dunx-dashboard](./roadmap/dunx-dashboard.md). `OpenApiModule.forRootAsync` closed the half of
[http-options-before-container](./roadmap/http-options-before-container.md) that
`OpenApiModule` owned; the `HttpOptions` half is still open and the template still
validates its config twice because of it.

**What held up under a clean-room consume,** which is worth as much as the bug list:
all 13 working subpath exports resolve at runtime and under `nodenext`;
`tsc --noEmit` is clean with optional peers absent; sourcemaps carry
`sourcesContent` so stack traces resolve despite `src/` not shipping; the transform
preload works from `node_modules` including subclass inheritance, forward references
and `inject()` in field initialisers; no peer warnings on a clean install; and
`bunx @dunx/create-app` scaffolds an app that boots, serves, typechecks and passes
its test.

## `internal/` - private workspaces, never published

### `internal/docs` - the documentation site - **built**

React + Mantine bundled by `Bun.build`, static output, deployed to **GitHub Pages** as the Pages
root. Coverage is a page inside it. Design and the parser decision:
[architecture/tooling.md](./architecture/tooling.md), "Documentation site"; the extractor's own
limits: `internal/docs/README.md`.

Nothing on the site is hand-written prose. The landing page is the root README,
the guides are `docs/*.md` through `Bun.markdown.html`, each package page is its
README plus an **API reference extracted from the doc comments** by
`oxc-parser`, and the coverage page reads the model `gen:cov` emits.

The three displacement consequences are handled:

- `scripts/coverage-report.ts` no longer writes standalone HTML. It writes
  `internal/docs/src/generated/coverage.json` and the badges into
  `internal/docs/public/badges/`.
- `ci.yml`'s Pages job uploads `./internal/docs/dist`, and a `Build the
documentation site` step runs after `test:cov` so the artifact has the
  coverage data the earlier `bun run build` could not have had.
- The README badges point at `/badges/coverage-<pkg>.svg` and link to
  `/#/coverage`; `scripts/update-readme.ts` generates them.

Still open: syntax highlighting in code blocks, the OpenAPI document
`@dunx/openapi` produces as a page here, and per-package code splitting.

### `internal/bench` - the benchmark harness - **built**

Eight subjects (raw `Bun.serve`, `@dunx/http`, Elysia, Hono on both Bun and Node, raw
`node:http`, Fastify, Express) across four identical workloads, plus cold-start.
Methodology, machine and every deliberate handicap are in
[`internal/bench/README.md`](../internal/bench/README.md); the measured findings are in
[architecture/benchmarks.md](./architecture/benchmarks.md), "Benchmark harness".

It publishes the losses. dunx costs 6-21% against raw `Bun.serve` depending on the
scenario, loses to Elysia on all four, and boots in roughly twice raw `Bun.serve`'s
time. Those numbers are in the README table, not a footnote.

Open follow-ups, none blocking:

- Pin the generator and the subject to disjoint CPU sets. Not needed on 32 cores;
  needed on a smaller machine.
- Open-loop latency via oha's `-q` plus `--latency-correction`, which would remove
  the coordinated-omission caveat the closed-loop numbers currently carry.
- The `params` gap against Elysia (85.8% vs 95.5% of the `Bun.serve` baseline) is the
  clearest optimisation target the harness has surfaced. Elysia compiles per-route
  handler code ahead of time; dunx builds a closure at boot but still runs a generic
  input reader per request.
- `internal/docs` should read `results/latest.json`. The shape is documented and
  versioned by `schemaVersion` in the bench README; do not re-derive it.

## The phase plan

Exit criteria are written as individually checkable statements on purpose.
`/whats-next` reads this section to place the work and to fill in `HANDOFF.md`'s
next steps, so a criterion that cannot be verified against the tree by inspection
is a criterion that gets reported wrong. Keep them mechanical.

The phases below are written from the framework's point of view.
[MIGRATION-FROM-NEST.md](./MIGRATION-FROM-NEST.md) is the same roadmap seen from
a migrating NestJS application, and it argues for two reorderings: route metadata
moves into Phase 2, and OpenAPI ahead of Phase 4. Read it before planning a phase.

### Phase 1 - DI proven end to end

Ship `@dunx/core` and a single `examples/full` app that boots a fully
dependency-injected application graph **with no HTTP at all**.

Keeping HTTP out is the point. If the example can only be evaluated by curling
it, ergonomic problems in the container hide behind routing. A no-HTTP example
forces `inject()`, tokens, async factories, and shutdown ordering to stand on
their own.

Exit criteria:

- `inject()` resolves classes and tokens, with inference and no manual generics
- `provide()` covers `useClass`, `useValue`, and async `useFactory`
- `@Module()` composes across at least two feature modules
- A circular dependency throws a readable error naming the full cycle
- `onInit` / `onShutdown` run in dependency order; `SIGTERM` closes cleanly
- Resolving a provider twice returns the same instance
- The example runs via `bun start`, exits 0, and CI asserts that

`examples/full` is one app that grows through the phases, not a new example per
phase. It was `examples/playground` until the examples were restructured; the rename
is cosmetic, but what sits beside it now is not.

Where a part needs a service CI does not have (Redis, Postgres, S3), it reports that
it is skipping and the app still exits 0 - otherwise CI teaches everyone to ignore
it.

#### Per-package examples were reverted; a ladder of four replaced them

The original decision - recorded here as "seven apps meant seven bootstraps to keep
alive and nowhere that showed the packages composing" - **stands, and was not
reversed.** What changed is that "one example" turned out to be the wrong reading of
it. There are now four, and the distinction is that they are not one per package:

| Example              | Answers                                                         |
| -------------------- | --------------------------------------------------------------- |
| `examples/minimal`   | "what does this framework look like?" - five files, two minutes |
| `examples/databases` | "how do I set up my database?" - SQLite ×2, Postgres, MySQL     |
| `examples/testing`   | "how do I test it?" - overrides, a real server, a guard         |
| `examples/full`      | "does it all actually compose?" - every package, one service    |

Each is a **question an evaluator asks in order**, not a package with a demo bolted
on. `@dunx/http` has no example of its own and never will; it appears in all four.
`full` is still the only place the packages are shown composing, which is what the
original objection was about, and it did not shrink to make room for the others.

**The maintenance objection still stands and is the binding constraint.** Every
example is a bootstrap that rots the moment nobody runs it, so each is wired into
CI the same way `full`'s `tour` is - `bun run --filter '@dunx/example-*' test` runs
all of their suites, and `full` additionally runs its `tour`. An example that cannot
be kept alive by CI does not get added. That is the whole test for whether a fifth
one earns its place, and it is why several plausible candidates were rejected:

- **An auth example.** It would be `full`'s `src/auth/` copied with the rest deleted:
  same better-auth config, same schema, same guard, no new question answered.
- **A queue / background-worker example.** Its entire subject needs Redis, so in CI
  it would skip and demonstrate nothing. `full`'s `bun run worker` already isolates
  the two-process shape, which is the part that is genuinely hard to see.
- **An OpenAPI-first example.** `full` already generates the document from the zod
  schemas its routes validate against; a second app would only have fewer routes in
  it.

#### `examples/databases` is one app with four configurations, not four apps

Four containers run in sequence inside one process. Module scoping would now let
four backends coexist in one container, each binding `DbConnection` in its own
scope, but running them in sequence is still what the example is _about_: each
configuration is read on its own, and a shared process would hide which connection
answered. One workspace rather than four is less to keep alive, and it puts the
SQLite-async and SQLite-sync services in adjacent files, which is where the choice
between them is actually made.

It uses `AppFactory`, not `HttpFactory`. That is the same argument Phase 1 makes
above: with no HTTP, nothing about the database wiring can hide behind a route.

MySQL is the interesting part, and it is a **fifth backend that `@dunx/infra/db`
does not ship**, assembled in the example in about forty lines with no change to the
package - which is the strongest available evidence that `DbOptions.open()` is the
right seam. drizzle has no Bun-native MySQL driver, so it is `drizzle-orm/mysql-proxy`
with `Bun.SQL` as the transport: drizzle owns the dialect, Bun owns the socket, and
`mysql2` is never installed. Verified against MySQL 8; the callback contract, the
two `Bun.SQL` bugs it works around, and the transaction gap are all in
[bun-apis.md](./bun-apis.md), "`Bun.SQL` and `bun:sqlite`".

Promoting it into `@dunx/infra/db` as a `MysqlOptions<TSchema>` is a reasonable next
step and deliberately not taken here: the example is the place to prove it works
before it becomes a supported surface with a schema type parameter to maintain.

### Phase 2 - HTTP

`@dunx/http`, the `Bun.serve` adapter, the middleware chain, the error mapper,
and route-collision detection. `examples/full` grows a controller; its Phase 1
assertions keep passing unchanged.

Also `@dunx/transform`, the load-time transform that makes constructor injection
work. It landed here rather than in Phase 1 because the need only became clear
once real application code was being written against `inject()`.

Exit criteria:

- A class with constructor parameters resolves without any annotation
- A parameter whose type is erased fails at boot naming that parameter
- A subclass with no constructor of its own inherits its base's dependencies
- `inject()` still works, and both mechanisms work in one class
- `examples/full` uses constructor injection throughout and `bun start` exits 0

### Phase 3 - Validation

Standard Schema wiring and typed route input. Gated on the inference spike
below.

### Phase 4 - Testing & scaffolder

`@dunx/testing` (`createTestApp({ modules, overrides })`, real server on port 0)
and `@dunx/create-app`.

### Phase 5 - OpenAPI - **built**

`@dunx/openapi` generates an OpenAPI 3.1 document from the zod schemas already on the
route decorators and serves self-contained HTML. Security requirements come from the
guards' own `@Public()` / `@Roles()` metadata. Zod is a `peerDependency`; the per-vendor
adapter this section anticipated is a vendor check around `z.toJSONSchema`.

#### Four corrections from porting `dunx-template`

The port produced a document that was internally incoherent, and the fixes each
turned on where a piece of information lives rather than on the generator's logic.

**A method-level `@ApiDoc` used to replace the class-level one wholesale**, because a
route's resolved `meta` is a `MetaRecord` and a handler's value overrides the class's
in it. That is right for `@Roles` and `@Public`, which are single values, and wrong for
a value made of independent fields - class `tags` plus a per-method `summary` is the
most common annotation pattern there is, and it was unreachable. The merge cannot be
recovered from an already-collapsed record, so `DiscoveredRoute` now carries
`classMeta` next to `meta` and `apiDocFor` composes the two per field. The alternative
considered and rejected was a per-key merge function on `MetaKey`: it needs a
symbol-to-merger registry that `mergeMeta` can reach, and with two copies of
`@dunx/http` in a tree the lookup misses and the old behaviour comes back silently.
Mutating each method's record from the class decorator was rejected too - it
accumulates at class-definition time, which is exactly the cross-file leak the marker
design avoids, and a subclass would rewrite its base's functions.

**`doc.tags` used to be derived from class names** while the operations carried
`@ApiDoc` tags, so the document declared tags nothing used and used tags it never
declared. It is now read back off the built operations, which makes the two agree by
construction rather than by two derivations happening to match.

**`RouteSchemas` gained `response`**, keyed by status code and taking the same
Standard Schema values the request side takes, so a named response schema hoists into
`components/schemas` exactly as a body does. Two decisions inside it: it is converted
with `io: 'output'` rather than `'input'`, because it describes what comes back (a
defaulted field is always present, `additionalProperties: false` is an output-side
claim) - the cost is that a schema used both ways converts twice and one
`.meta({ id })` cannot name both views if they differ. And it is **never validated**:
a per-response validation pass paid for a documentation feature is the wrong trade
when the handler's return type already checks the answer for free. Nothing in
`@dunx/http`'s request path reads the key.

The explorer renders those responses through **`SchemaView`, the same component the
request body uses** - one property table with the required markers, formats,
constraints and `$ref` resolution, not a second one. Every component in
`internal/openapi-ui` costs bytes twice, in the JS and in the CSS list in
`src/styles.ts`, and the whole bundle is a committed string in
`packages/openapi/src/ui-bundle.ts` that every consumer of the package downloads, so
"reuse it" is a size decision before it is a taste one. The documented response and
the try-it-out result stay **separate**: the `Responses` section is the contract and
the panel under the `Send it` divider is one real request, and merging them would let
a 500 from a local run read as the specification. `src/operation.test.tsx` holds all
of that down.

**`OpenApiModule.forRootAsync`** exists for the reason every other configurable
module has the pair. Its interesting half was the mount paths: a decorator's
arguments are evaluated when the class definition is, long before a container could
run the factory. So `RouteMeta.path` became `RoutePath` - `string | (() => string)`,
resolved by `discoverRoutes`, which runs after every provider has settled. The
alternatives were worse: exporting `markRoute` so the factory could re-mark its own
prototype is a mutation escape hatch with no other caller, and pushing the controller
into the module's `controllers` array from inside the factory is too late, since
controllers are registered as providers while the container is being built.

## Spikes to resolve

Run through `/spike`: measure on real Bun, record the result in
[architecture/constraints.md](./architecture/constraints.md), then delete the item from here. A spike that changes the
public API shape belongs before the code it gates.

None open. Route input inference was the last one; its result is recorded in
[architecture/constraints.md](./architecture/constraints.md).

## Rejected - do not reopen without reading why

Recorded with measurements in [ARCHITECTURE.md](./ARCHITECTURE.md):
`ctx.metadata`, the pending-array accumulator, `experimentalDecorators` /
`emitDecoratorMetadata` / `reflect-metadata`, request-scoped DI, a JavaScript router,
entity decorators carrying drizzle's schema types, `@dunx/core` auto-registering the
compiler plugin, per-package example apps, a hand-rolled `Database` contract spanning
both drizzle adapters, and running the `Bun.SQL` suite over that driver's SQLite
adapter.

**Reversed by request:** _per-module subgraphs_ was on this list and shipped in 1.0.0 -
see [architecture/dependency-injection.md](./architecture/dependency-injection.md),
"Modules encapsulate". The argument against it was real - a flat container has no "not
exported from module X" error and needs no `forwardRef` - but it traded away
module-scoped middleware and per-module rebinding, which a DI framework is expected to
have. Nobody was consuming dunx yet, so the reversal cost no migration. **Request-scoped
DI stays rejected** and is a different question: it is about a _lifetime_ per request,
not a _visibility_ boundary per module.
