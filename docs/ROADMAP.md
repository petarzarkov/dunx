# dunx - Roadmap

What is built, what is next, and the reference implementations to work from. Read
[ARCHITECTURE.md](./ARCHITECTURE.md) for the decisions behind the built parts and
[../CLAUDE.md](../CLAUDE.md) for the rules that constrain the next ones.

The governing principle, from CLAUDE.md Rule 1: **never reimplement what Bun does,
never invent what a mature library already solves.** Everything below is one or the
other.

## Built

| Package           | Contains                                                               |
| ----------------- | ---------------------------------------------------------------------- |
| `@dunx/core`      | DI container, modules, lifecycle, the `Logger` contract - zero deps    |
| `@dunx/transform` | Load-time transform: constructor parameter types                       |
| `@dunx/http`      | Routes, websocket gateways, middleware, guards, CORS, validation       |
| `@dunx/infra`     | `/db` (drizzle) `/redis` `/files` `/images` `/logger` (`@arkv/logger`) |
| `@dunx/openapi`   | OpenAPI 3.1 from route zod schemas, self-contained HTML                |
| `@dunx/testing`   | Bindings replaced in place, a real `Bun.serve` on port 0               |

The two integrations are deliberate, per Rule 1's second half: `drizzle-orm` is an
optional `peerDependency` and drives `bun:sqlite`/`Bun.SQL` through its own Bun
adapters; `@arkv/logger` is a `dependency` and satisfies core's `Logger` contract
structurally, with no adapter class in between.

## Reference implementations - do not design from scratch

`/home/petarzarkov/repos/nestjs-template` is a working production app by the same
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
[ARCHITECTURE.md](./ARCHITECTURE.md) - overrides are substituted into the same flat
list, keyed by token, so the duplicate-binding check still runs and a discarded
provider's factory never executes. The substitution itself is core's
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
[ARCHITECTURE.md](./ARCHITECTURE.md), "Database layer". Entity decorators were
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
design in [ARCHITECTURE.md](./ARCHITECTURE.md), "Queues".

**The ioredis collision resolved better than expected.** Measured on bullmq 6.0.5:
`ioredis` is an _optional_ peer of bullmq 6, which ships `createBunRedisClient` - an
adapter over **`Bun.RedisClient`** - and dunx uses it, so every byte of queue traffic
goes through Bun's client and no ioredis client is ever constructed. `ioredis` must
still be _installed_, because bullmq statically imports it, so it is an optional peer
of `@dunx/infra` too. CLAUDE.md's "Where the two halves collide" has since been
rewritten to match; the full measurement is in
[ARCHITECTURE.md](./ARCHITECTURE.md), "Queues".

**And the ioredis follow-ups are closed, one of them by falsifying it.** The advice
to _pin ioredis 5_ rested on three claims and re-measurement broke all three: ioredis
6.0.0 still ships `built/utils`, both of bullmq's builds import it, and the CJS build
is the one Bun actually runs. No pin. The advice is withdrawn from
`docs/guide/14-queues.md` and `bun-apis.md`, where it had been published to users.
The companion finding - `/queue` cannot be imported without ioredis while the manifest
calls it optional - is not a contradiction once stated properly: `ioredis` is optional
in exactly the sense `bullmq` is, needed if and only if `/queue` is, and there is no
deep-import escape because `bullmq/dist/{cjs,esm}/classes/queue.js` both fail without
it. The range skew (`>=5.0.0` peer against a `^6.0.0` dev dependency) is fixed by
making the dev dependency match, and two tests in `packages/infra/src/index.test.ts`
now hold the shape: dunx's ioredis peer range must equal the installed bullmq's, and
both peers must be optional together. Reasoning in
[ARCHITECTURE.md](./ARCHITECTURE.md), "Not pinning ioredis 5".

**`@dunx/auth` keeps its name.** `@dunx/better-auth` was declined, and not only on the
cost of renaming a published package: every dunx integration is named for the
capability rather than the vendor, so `@dunx/infra/db` is drizzle without being called
`@dunx/drizzle` and `@dunx/infra/queue` is bullmq without being called `@dunx/bullmq`.
Renaming auth alone would have made it the one vendor-named package in the set.
[ARCHITECTURE.md](./ARCHITECTURE.md), "And it stays `@dunx/auth`".

**Versioning stays lockstep until core 1.0.0.** There is no pre-1.0 range policy that
works - a caret cannot span a `0.x` minor, and `>=` promises across majors dunx cannot
keep - and no work done now would survive the 1.0 change.
[ARCHITECTURE.md](./ARCHITECTURE.md), "Versioning is lockstep".

**`@dunx/infra/logger` no longer colours a pipe.** `@arkv/logger` chooses coloured
output from `NODE_ENV` with no terminal check anywhere on the path, so the
zero-argument `LoggerModule.forRoot()` wrote ANSI escapes into its JSON in any
container with `NODE_ENV` unset, and neither `NO_COLOR` nor `FORCE_COLOR=0` helped.
dunx now defaults `isDevelopment` to `Bun.enableANSIColors` - a default, not a patch,
and the Bun-specific half by CLAUDE.md's own boundary. The portable gate is written up
as a proposal against `@arkv/colors`' existing `isColorSupported()` in
[arkv-integrations](./roadmap/arkv-integrations.md), together with a second defect it
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
[ARCHITECTURE.md](./ARCHITECTURE.md), "Authentication".

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
[ARCHITECTURE.md](./ARCHITECTURE.md), "Multi-node websocket fan-out".

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

## Open items

**One file per item in [docs/roadmap/](./roadmap/).** Delete a file when its item is
delivered rather than marking it done, so the folder only ever holds open work.
Feedback goes in as a new file rather than into conversation.

| Item                                                                                | Shape                                                                 |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [cross-language-benchmark-subjects](./roadmap/cross-language-benchmark-subjects.md) | Feature. Gin, Axum, Spring. Also a falsification test on the harness. |
| [design-polish](./roadmap/design-polish.md)                                         | Feature. Landing page rebuilt; not yet striking.                      |
| [async-local-storage-cost](./roadmap/async-local-storage-cost.md)                   | Measured. +0.91 us, and `enterWith` segfaults Bun.                    |
| [document-pinning-all-packages](./roadmap/document-pinning-all-packages.md)         | Docs. Mixing minors warns and can duplicate core.                     |
| [arkv-integrations](./roadmap/arkv-integrations.md)                                 | Three upstream proposals. Nothing left to adopt.                      |
| [adopt-from-nestjs-template](./roadmap/adopt-from-nestjs-template.md)               | Ongoing. Better Auth OpenAPI merge adopted.                           |
| [independent-versions](./roadmap/independent-versions.md)                           | Closed. One line, reopened by core 1.0.0.                             |
| [queue-shutdown-sigterm](./roadmap/queue-shutdown-sigterm.md)                       | Defect. Not reachable from userland.                                  |
| [flaky-aggregate-suite](./roadmap/flaky-aggregate-suite.md)                         | Unreproduced.                                                         |
| [relay-boot-subscribe](./roadmap/relay-boot-subscribe.md)                           | Delivered, with a boundary note worth keeping.                        |

### From porting nestjs-template to dunx-template

The template was rebuilt on dunx 0.1.1 with all eight packages installed **from
npm**, which is the only way packaging faults surface. It runs: 52 unit and
integration tests, 10 e2e, 90% line coverage, Docker builds and serves. It also
produced 22 findings.

| Item                                                                                  | Shape                                               |
| ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| [di-dynamic-module-unions-decorator](./roadmap/di-dynamic-module-unions-decorator.md) | Bug, high. Blocks the standard Nest module pattern. |
| [di-overrides-rejects-self-bound](./roadmap/di-overrides-rejects-self-bound.md)       | Bug, high. Blocks the common unit-test stub.        |
| [transform-emitted-js-diagnostic](./roadmap/transform-emitted-js-diagnostic.md)       | Bug, high. Error tells you to do what you did.      |
| [di-import-type-diagnostic](./roadmap/di-import-type-diagnostic.md)                   | Diagnostic, high frequency.                         |
| [openapi-forroot-async](./roadmap/openapi-forroot-async.md)                           | Missing feature, medium. `HttpOptions` half only.   |

**What held up under a clean-room consume,** which is worth as much as the bug list:
all 13 working subpath exports resolve at runtime and under `nodenext`;
`tsc --noEmit` is clean with optional peers absent; sourcemaps carry
`sourcesContent` so stack traces resolve despite `src/` not shipping; the transform
preload works from `node_modules` including subclass inheritance, forward references
and `inject()` in field initialisers; no peer warnings on a clean install; and
`bunx @dunx/create-app` scaffolds an app that boots, serves, typechecks and passes
its test.

## `tools/` - private workspaces, never published

### `tools/docs` - the documentation site - **built**

React + Mantine bundled by `Bun.build`, static output, deployed to **GitHub Pages** as the Pages
root. Coverage is a page inside it. Design and the parser decision:
[ARCHITECTURE.md](./ARCHITECTURE.md), "Documentation site"; the extractor's own
limits: `tools/docs/README.md`.

Nothing on the site is hand-written prose. The landing page is the root README,
the guides are `docs/*.md` through `Bun.markdown.html`, each package page is its
README plus an **API reference extracted from the doc comments** by
`oxc-parser`, and the coverage page reads the model `gen:cov` emits.

The three displacement consequences are handled:

- `scripts/coverage-report.ts` no longer writes standalone HTML. It writes
  `tools/docs/src/generated/coverage.json` and the badges into
  `tools/docs/public/badges/`.
- `ci.yml`'s Pages job uploads `./tools/docs/dist`, and a `Build the
documentation site` step runs after `test:cov` so the artifact has the
  coverage data the earlier `bun run build` could not have had.
- The README badges point at `/badges/coverage-<pkg>.svg` and link to
  `/#/coverage`; `scripts/update-readme.ts` generates them.

Still open: syntax highlighting in code blocks, the OpenAPI document
`@dunx/openapi` produces as a page here, and per-package code splitting.

### `tools/bench` - the benchmark harness - **built**

Eight subjects (raw `Bun.serve`, `@dunx/http`, Elysia, Hono on both Bun and Node, raw
`node:http`, Fastify, Express) across four identical workloads, plus cold-start.
Methodology, machine and every deliberate handicap are in
[`tools/bench/README.md`](../tools/bench/README.md); the measured findings are in
[ARCHITECTURE.md](./ARCHITECTURE.md), "Benchmark harness".

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
- `tools/docs` should read `results/latest.json`. The shape is documented and
  versioned by `schemaVersion` in the bench README; do not re-derive it.

## Rejected - do not reopen without reading why

Recorded with measurements in [ARCHITECTURE.md](./ARCHITECTURE.md):
`ctx.metadata`, the pending-array accumulator, `experimentalDecorators` /
`emitDecoratorMetadata` / `reflect-metadata`, request-scoped DI, per-module
subgraphs, a JavaScript router, entity decorators carrying drizzle's schema types,
`@dunx/core` auto-registering the compiler plugin, per-package example apps, a
hand-rolled `Database` contract spanning both drizzle adapters, and running the
`Bun.SQL` suite over that driver's SQLite adapter.
