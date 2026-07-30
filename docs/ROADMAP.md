# dunx — Roadmap

What is built, what is next, and the reference implementations to work from. Read
[ARCHITECTURE.md](./ARCHITECTURE.md) for the decisions behind the built parts and
[../CLAUDE.md](../CLAUDE.md) for the rules that constrain the next ones.

The governing principle, from CLAUDE.md Rule 1: **never reimplement what Bun does,
never invent what a mature library already solves.** Everything below is one or the
other.

## Built

| Package          | Contains                                                               |
| ---------------- | ---------------------------------------------------------------------- |
| `@dunx/core`     | DI container, modules, lifecycle, the `Logger` contract — zero deps    |
| `@dunx/compiler` | Load-time transform: constructor parameter types                       |
| `@dunx/http`     | Routes, websocket gateways, middleware, guards, CORS, validation       |
| `@dunx/infra`    | `/db` (drizzle) `/redis` `/files` `/images` `/logger` (`@arkv/logger`) |
| `@dunx/openapi`  | OpenAPI 3.1 from route zod schemas, self-contained HTML                |

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

## Next, in order

Each item makes the following one smaller. That ordering is deliberate.

### 1. Better Auth

Framework-agnostic, so it fits `@dunx/http` middleware. Reference:
`nestjs-template/src/auth/auth.config.ts`. Should compose with the guards already
built — `@Public()` and `@Roles()` exist and OpenAPI already reads them for security
schemes.

### 2. Queues — `@dunx/infra/queue` on BullMQ

The largest remaining item. Needs job discovery (the marker-plus-prototype-scan
technique from routes and gateways is the precedent — see ARCHITECTURE.md "Route
discovery"), a dispatcher, a publisher, and a worker entrypoint. Note that
**`bullmq` depends on `ioredis`**, which Rule 1 bans for dunx's own code; the
boundary is recorded in CLAUDE.md under "Where the two halves collide".

### 3. Redis as the WebSocket adapter

Multi-node gateway fan-out. `@dunx/http`'s gateways currently use Bun's native
pub/sub, which is per-process. Reference:
`nestjs-template/src/notifications/events/socket.adapter.ts`.

## `tools/` — private workspaces, never published

### `tools/docs` — the documentation site

A frontend package built to static output and published to **GitHub Pages**,
replacing the coverage report as the Pages root. Coverage becomes **a page inside
it** rather than the whole site.

Consequences to handle:

- `scripts/coverage-report.ts` currently owns the Pages output and the badges. It
  needs to emit into the docs site instead of publishing standalone.
- The `ci.yml` Pages job changes target.
- The README's coverage badges point at the current layout and will break.

Content should be generated from what already exists rather than hand-maintained:
`docs/*.md` (Bun's `Bun.markdown` can render it), each package's README, and the
OpenAPI document `@dunx/openapi` already produces.

### `tools/bench` — later

A benchmark harness against other backend frameworks and runtimes. Worth doing only
once the HTTP surface is stable, and worth doing honestly: publish the methodology,
the machine, and the losses as well as the wins. A benchmark that only ever shows
dunx winning is marketing, not measurement.

## Rejected — do not reopen without reading why

Recorded with measurements in [ARCHITECTURE.md](./ARCHITECTURE.md):
`ctx.metadata`, the pending-array accumulator, `experimentalDecorators` /
`emitDecoratorMetadata` / `reflect-metadata`, request-scoped DI, per-module
subgraphs, a JavaScript router, entity decorators carrying drizzle's schema types,
`@dunx/core` auto-registering the compiler plugin, per-package example apps, a
hand-rolled `Database` contract spanning both drizzle adapters, and running the
`Bun.SQL` suite over that driver's SQLite adapter.
