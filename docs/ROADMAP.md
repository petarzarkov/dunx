# dunx — Roadmap

What is built, what is next, and the reference implementations to work from. Read
[ARCHITECTURE.md](./ARCHITECTURE.md) for the decisions behind the built parts and
[../CLAUDE.md](../CLAUDE.md) for the rules that constrain the next ones.

The governing principle, from CLAUDE.md Rule 1: **never reimplement what Bun does,
never invent what a mature library already solves.** Everything below is one or the
other.

## Built

| Package          | Contains                                                         |
| ---------------- | ---------------------------------------------------------------- |
| `@dunx/core`     | DI container, modules, lifecycle, `Logger` contract              |
| `@dunx/compiler` | Load-time transform: constructor parameter types                 |
| `@dunx/http`     | Routes, websocket gateways, middleware, guards, CORS, validation |
| `@dunx/infra`    | `/db` (drizzle) `/redis` `/files` `/images`                      |
| `@dunx/openapi`  | OpenAPI 3.1 from route zod schemas, self-contained HTML          |

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

## Next, in order

Each item makes the following one smaller. That ordering is deliberate.

### 1. Documentation debt (do first — everything else builds on trust in the docs)

- `packages/infra/README.md` is materially wrong after the drizzle rewrite. Known
  false statements include "`Date` is normalised for you" and "the `Bun.SQL` suite
  runs over the SQLite adapter". The `## db` section needs rewriting against the
  drizzle API.
- `docs/ARCHITECTURE.md` needs: drizzle as the default driver, the
  `drizzle-orm/bun-sql` hardcoded-`PgDialect` finding, drizzle's bun-sqlite
  `transaction()` inheriting the async-rollback quirk, and the TypeScript 7.0.2
  measurement behind the entity-decorator verdict.
- `CLAUDE.md`'s package table and `README.md` describe `@dunx/core` without its
  `Logger`.

### 2. The logger decision — OPEN, needs the owner

`@dunx/core/logger` currently holds a **port** of `@arkv/logger`, written before the
"reuse `@arkv`" rule existed. It is 112 tests at 100% line coverage and it contains
**fixes the upstream package does not have**:

- 10 sanitizer bugs, each with a test that fails against `@arkv/logger` 0.7.6 —
  shared references misreported as `[Circular]`, a self-referencing array
  overflowing the stack, `Map`/`Set` silently vanishing, a throwing getter killing
  the whole log call, typed arrays serialising a megabyte buffer as a megabyte of
  JSON, `Blob` misdetected because Bun's `Blob` answers `'name' in blob` with `true`.
- `Bun.color(hex, 'ansi')` degrading to `ansi-16`, which writes the colour index as
  a **raw byte** — index 10 is `\n`, so a coloured log line silently became two
  records. See [bun-apis.md](./bun-apis.md).
- `LogLevel` as a frozen object rather than a TS `enum` (which `dunx/no-enum` bans).

Per the rule, dunx should **depend on `@arkv/logger`** and these fixes should be
**pushed upstream** rather than deleted. Deleting the port without porting the fixes
reintroduces ten known bugs.

Recommended shape, which also preserves `@dunx/core`'s empty dependency list:

- the **`Logger` abstract contract stays in `@dunx/core`** (zero dependencies), so
  `@dunx/http` middleware can inject it without depending on anything;
- the **`@arkv/logger`-backed implementation and `LoggerModule` live in
  `@dunx/infra`**, where dependencies are already normal;
- the app binds it, exactly as it binds a database.

### 3. Drizzle as the documented default

The driver is built and tested (190 tests). What remains is positioning: manifest
wording, README, and removing any language implying the old hand-rolled contract is
an alternative. Entity decorators were **measured and rejected** — see
ARCHITECTURE.md; drizzle's native `sqliteTable` object schema is the supported path.
The compiler's field reader was built for them and has been **reverted**, since it
shipped as public API serving nothing. `erased.ts` stayed — the constructor reader
needs it.

### 4. Better Auth

Framework-agnostic, so it fits `@dunx/http` middleware. Reference:
`nestjs-template/src/auth/auth.config.ts`. Should compose with the guards already
built — `@Public()` and `@Roles()` exist and OpenAPI already reads them for security
schemes.

### 5. Queues — `@dunx/infra/queue` on BullMQ

The largest remaining item. Needs job discovery (the marker-plus-prototype-scan
technique from routes and gateways is the precedent — see ARCHITECTURE.md "Route
discovery"), a dispatcher, a publisher, and a worker entrypoint. Note that
**`bullmq` depends on `ioredis`**, which Rule 1 bans for dunx's own code; the
boundary is recorded in CLAUDE.md under "Where the two halves collide".

### 6. Redis as the WebSocket adapter

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
`@dunx/core` auto-registering the compiler plugin, and per-package example apps.
