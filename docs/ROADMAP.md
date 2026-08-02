# dunx — Roadmap

What is built, what is next, and the reference implementations to work from. Read
[ARCHITECTURE.md](./ARCHITECTURE.md) for the decisions behind the built parts and
[../CLAUDE.md](../CLAUDE.md) for the rules that constrain the next ones.

The governing principle, from CLAUDE.md Rule 1: **never reimplement what Bun does,
never invent what a mature library already solves.** Everything below is one or the
other.

## Built

| Package           | Contains                                                               |
| ----------------- | ---------------------------------------------------------------------- |
| `@dunx/core`      | DI container, modules, lifecycle, the `Logger` contract — zero deps    |
| `@dunx/transform` | Load-time transform: constructor parameter types                       |
| `@dunx/http`      | Routes, websocket gateways, middleware, guards, CORS, validation       |
| `@dunx/infra`     | `/db` (drizzle) `/redis` `/files` `/images` `/logger` (`@arkv/logger`) |
| `@dunx/openapi`   | OpenAPI 3.1 from route zod schemas, self-contained HTML                |
| `@dunx/testing`   | Bindings replaced in place, a real `Bun.serve` on port 0               |

The two integrations are deliberate, per Rule 1's second half: `drizzle-orm` is an
optional `peerDependency` and drives `bun:sqlite`/`Bun.SQL` through its own Bun
adapters; `@arkv/logger` is a `dependency` and satisfies core's `Logger` contract
structurally, with no adapter class in between.

## Reference implementations — do not design from scratch

`/home/petarzarkov/repos/nestjs-template` is a working production app by the same
owner. **Read the relevant part before designing any of the items below.** It is
NestJS-shaped, so port the _approach_, not the wiring.

| Concern                               | Reference                                                                                                                                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queues, job processing, job discovery | `src/infra/queue/` — `job.processor.ts`, `job.module.ts`, `decorators/job-handler.decorator.ts`, `services/job-dispatcher.service.ts`, `services/job-publisher.service.ts` |
| Worker/child-process spawning         | `src/infra/queue/job.module.ts` — what a spawned worker actually needs                                                                                                     |
| Redis everywhere                      | `src/infra/redis/`                                                                                                                                                         |
| Redis as a WebSocket adapter          | `src/notifications/events/socket.adapter.ts`                                                                                                                               |
| Drizzle schemas, migrations, seeders  | `src/infra/db/` — `schema.ts`, `migrations/`, `seeders/`, `base.repository.ts`                                                                                             |
| Zod DTOs and validation               | `src/config/env-vars.dto.ts`, `src/core/zod/`                                                                                                                              |
| Auth                                  | `src/auth/auth.config.ts` (Better Auth)                                                                                                                                    |

## Settled — the outcome, so the reasoning is not re-litigated

**The logger.** `@dunx/core` used to hold a full **port** of `@arkv/logger`, written
before the "reuse `@arkv`" rule existed, carrying fixes upstream did not have. The
port is gone and the fixes went **upstream** rather than being deleted: they shipped
as `@arkv/logger@0.8.0` / `@arkv/shared@0.8.0` — ten sanitizer bugs (shared
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
class between them — upstream's `Logger` satisfies the contract structurally.

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
[ARCHITECTURE.md](./ARCHITECTURE.md) — overrides are substituted into the same flat
list, keyed by token, so the duplicate-binding check still runs and a discarded
provider's factory never executes. The substitution itself is core's
(`AppFactory.create(root, { overrides })`), because `Injector` and `readModule` stay
unexported; the decisions that went beyond the spec are recorded under "Test
harness". The example app is written against it: `service.test.ts` drives the real
bootstrap through the client, and `overrides.test.ts` boots the users slice with
`Logger` replaced.

Two things it surfaced. First, `bun run --filter '*'` orders builds by
`dependencies` only, so **a published package's tests cannot import a workspace
package that is not one of its runtime dependencies** — converting
`packages/openapi/src/module.test.ts` made openapi's build race the harness's and was
reverted. Second, `workspace:*` publishes as an **exact** version, which would give a
consumer a nested second `@dunx/core` and therefore tokens that match nothing;
`@dunx/testing` uses `workspace:^`, and the other packages should be looked at. While
core is pre-1.0 that still needs `@dunx/testing` republished whenever core or http
takes a **minor** bump, since `^0.4.0` does not admit `0.5.0`.

What remains: **`@dunx/create-app`**, the other half of Phase 4. Nothing in the
harness blocks it. Two smaller omissions, both deliberate and recorded in
`packages/testing/README.md` so they are not re-litigated by accident — no websocket
helper (Bun's native `WebSocket` against `server.url` is already the whole test) and
no `providers` key on the options (a fixture class goes in a two-line `@Module`).

**Drizzle as the database layer.** Built, tested, and now documented as _the_
driver rather than an option. The hand-rolled `Database` contract, `Repository` and
`quoteIdentifier` are retired; the reasoning is in
[ARCHITECTURE.md](./ARCHITECTURE.md), "Database layer". Entity decorators were
**measured and rejected** — the compiler's field reader, built for them, was
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
deliberately different objects — `forRoot` binds the publish side only, so a web
process opens no worker. Documented in `packages/infra/README.md`, "queue", with the
design in [ARCHITECTURE.md](./ARCHITECTURE.md), "Queues".

**The ioredis collision resolved better than expected, and CLAUDE.md is now stale
on it.** CLAUDE.md's "Where the two halves collide" section says `ioredis` arrives
transitively as bullmq's engine and that an app therefore gets both clients. Measured
on bullmq 6.0.5: `ioredis` is an _optional_ peer of bullmq 6, which ships
`createBunRedisClient` — an adapter over **`Bun.RedisClient`** — and dunx uses it, so
every byte of queue traffic goes through Bun's client and no ioredis client is ever
constructed. `ioredis` must still be _installed_, because bullmq's barrel statically
imports it, so it is an optional peer of `@dunx/infra` too. That section of CLAUDE.md,
and its `@dunx/infra` subpath row, want an owner's edit; the full measurement is in
[ARCHITECTURE.md](./ARCHITECTURE.md), "Queues".

**Documentation debt.** `packages/infra/README.md`'s `## db` section was rewritten
against the drizzle API, and its `## logger` section added. `ARCHITECTURE.md` gained
the hardcoded-`PgDialect` and drizzle-`transaction()` measurements and the database
design section. Manifest descriptions, `CLAUDE.md`'s package table and the root
README now name the `Logger` contract and `/logger`.

**Better Auth is `@dunx/auth`, a sixth package.** Not `@dunx/infra/auth`: the guard is
`@dunx/http` middleware reading `@dunx/http`'s `PUBLIC`/`ROLES` keys, and `@dunx/infra`
must not depend on the web layer — the coupling refused earlier for a request logger in
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
`secondaryStorage` methods — including the two better-auth marks optional because most
clients cannot do them atomically and `Bun.RedisClient` can. Refused: a schema for
better-auth's tables (its CLI generates them and they follow the plugins), and any part
of the auth flow itself.

The measurements and the two-strings-for-one-URL `basePath`/`mountAt` problem are in
[ARCHITECTURE.md](./ARCHITECTURE.md), "Authentication".

**Redis as the WebSocket adapter — built.** Multi-node gateway fan-out, and the
dependency question that blocked it is settled: **both the contract and the Redis
implementation live in `@dunx/http`**. `PubSubRelay` is two methods (publish,
subscribe); the default is no relay and exactly today's per-process behaviour;
`RedisRelay` is `Bun.RedisClient` directly, so `@dunx/http` still depends only on
`@dunx/core`. Putting it in `@dunx/infra/redis` was rejected on the dependency
direction — that would be the fourth time `@dunx/infra` was asked to depend on the
web layer. The cost accepted is a little relay-specific connection glue instead of
reusing `@dunx/infra/redis`'s general-purpose client.

An app that would rather reuse its own connections satisfies the two methods itself,
and `@dunx/infra`'s `RedisConnection` **already does, structurally** — the full example
runs its second node on exactly that. Reasoning, the one-channel constraint that
`psubscribe` forces, and the duplicate-delivery defence:
[ARCHITECTURE.md](./ARCHITECTURE.md), "Multi-node websocket fan-out".

It also turned up two Bun findings worth remembering as one **class** of bug, both
now in [bun-apis.md](./bun-apis.md): a `Bun.RedisClient` holds the event loop open
after `close()` both when it **entered** subscriber mode and when a `subscribe()`
**failed to connect** — so a cleanly shut-down service never exits, `maxRetries: 0`
does not help, and `bun test` cannot see any of it because the runner exits the
process itself. The fixes are `unsubscribe()` before `close()`, and `connect()`
before `subscribe()`. Both were already latent in `@dunx/infra/redis`, which now
does each and has a spawn-based test — the only kind that can observe a held-open
event loop — guarding it.

**Documentation debt.** `packages/infra/README.md`'s `## db` section was rewritten
against the drizzle API, and its `## logger` section added. `ARCHITECTURE.md` gained
the hardcoded-`PgDialect` and drizzle-`transaction()` measurements and the database
design section. Manifest descriptions, `CLAUDE.md`'s package table and the root
README now name the `Logger` contract and `/logger`.

## Next, in order

**Every item that was on this list is built.** Better Auth, queues and the websocket
relay all landed, along with `@dunx/testing` — which means the ordering argument that
used to live here has been spent, and what follows is a fresh list rather than a
renumbered one.

### 1. `@dunx/core` as a `peerDependency` — the build half is done

Versioning is currently **lockstep** because `version.ts` rewrites `workspace:*` to an
exact version, and independent versions would let an app install two copies of
`@dunx/core` — fatal here, because a DI token _is_ a class object. See
[ARCHITECTURE.md](./ARCHITECTURE.md), "Versioning is lockstep".

Peer dependencies are the better end state: they guarantee one copy without forcing
every package to re-publish on every release. What blocked them was that
`bun run --filter '*' build` ordered builds by `dependencies` alone — moving core to a
peer was tried and the build failed with `TS7016`, because `tsc` in `@dunx/http` raced
core's own `.d.ts` emit.

**That blocker is gone.** `bun run build` is now `scripts/build-all.ts`, which orders
by `dependencies`, `peerDependencies` **and** `devDependencies` restricted to workspace
packages, and emits waves rather than a queue so unrelated packages still build
concurrently — 3 waves over 8 workspaces in ~3 s.

What is left is the migration itself, and it is not just moving a field. Each of
`@dunx/http`, `@dunx/infra`, `@dunx/openapi`, `@dunx/auth` and `@dunx/testing` declares
`@dunx/core` (and some also `@dunx/http`) as a `workspace:*` dependency. Moving those to
peers means: a matching `devDependency` so the workspace still links for build and test,
a real semver range at publish rather than `workspace:*` — which is a decision
`scripts/version.ts` currently sidesteps by rewriting to an exact version — and a call on
whether versioning stays lockstep. Lockstep plus peers is coherent and safe; independent
versions plus peers is the actual prize and needs the range policy settled first.
See [ARCHITECTURE.md](./ARCHITECTURE.md), "Versioning is lockstep".

### 2. `@dunx/create-app`

The last unbuilt item from the original phase list: a scaffolder. Everything it would
generate now exists, which is the reason it was left until last.

### 3. The loose ends the built work left behind

Small, independent, each recorded where it belongs:

- **A relay whose boot subscribe failed is retried by nothing.** Raising `maxRetries`
  is the only recovery today. `@dunx/http`, `ws/relay.ts`.
- **A process that attempted a queue operation while Redis was down does not exit on
  `SIGTERM`** — bullmq holds a connection whose retry timer outlives `close()`, and
  nothing in userland can reach it. Importing the module is not enough to trigger it;
  a healthy Redis is unaffected. Measured, with the table in
  [bun-apis.md](./bun-apis.md). Serving is unaffected, so this is a shutdown defect
  only.
- **bullmq 6.0.5's CJS build imports `ioredis/built/utils`, which ioredis 6 removed.**
  The ESM build does not, which is why the suite passes. Pin ioredis 5 if anything
  might load the CJS entry.
- **No in-process HTTP + worker composition.** `WorkerFactory` builds its own
  container, so a single process cannot both serve and consume. Deliberate, but it is
  why the full example needs `bun run worker`.
- **`@dunx/testing` cannot be used by another published package's tests**, only by
  `examples/*`, for the same build-ordering reason as item 1. The topological build
  removes the ordering problem; this has not been re-tried since.

## `tools/` — private workspaces, never published

### `tools/docs` — the documentation site — **built**

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

### `tools/bench` — the benchmark harness — **built**

Eight subjects (raw `Bun.serve`, `@dunx/http`, Elysia, Hono on both Bun and Node, raw
`node:http`, Fastify, Express) across four identical workloads, plus cold-start.
Methodology, machine and every deliberate handicap are in
[`tools/bench/README.md`](../tools/bench/README.md); the measured findings are in
[ARCHITECTURE.md](./ARCHITECTURE.md), "Benchmark harness".

It publishes the losses. dunx costs 6–21% against raw `Bun.serve` depending on the
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

## Rejected — do not reopen without reading why

Recorded with measurements in [ARCHITECTURE.md](./ARCHITECTURE.md):
`ctx.metadata`, the pending-array accumulator, `experimentalDecorators` /
`emitDecoratorMetadata` / `reflect-metadata`, request-scoped DI, per-module
subgraphs, a JavaScript router, entity decorators carrying drizzle's schema types,
`@dunx/core` auto-registering the compiler plugin, per-package example apps, a
hand-rolled `Database` contract spanning both drizzle adapters, and running the
`Bun.SQL` suite over that driver's SQLite adapter.
