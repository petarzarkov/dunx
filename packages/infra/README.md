# @dunx/infra

Infrastructure for [dunx](https://github.com/petarzarkov/dunx): databases,
Redis/Valkey, queues, file storage, images, scheduling, pagination and logging.
Eight areas, one package.

Where Bun ships the primitive, the primitive is what runs: `Bun.SQL`,
`bun:sqlite`, `Bun.RedisClient`, `Bun.file`, `Bun.Glob`, `Bun.S3Client`,
`Bun.Image`, `Bun.cron`. No `pg`, no `better-sqlite3`, no `ioredis`, no
`@aws-sdk`, no `glob`, no `sharp`.

Three areas integrate a mature library rather than hand-rolling one, and each of
those drives a Bun API underneath. `drizzle-orm` and `bullmq` are **optional peer
dependencies**, so an app using only `/files` installs neither.

## Install

```bash
bun add @dunx/infra @dunx/core
# plus what the areas you use need
bun add drizzle-orm   # /db
bun add bullmq        # /queue
```

## The subpaths

The guide is canonical for every row; this table is the index.

| Subpath                  | What it is                                                       | Guide                                                       |
| ------------------------ | ---------------------------------------------------------------- | ----------------------------------------------------------- |
| `@dunx/infra/db`         | **drizzle** over `bun:sqlite` and `Bun.SQL`, transactions, seeds, query timings | [Database](../../docs/guide/14-database.md)                 |
| `@dunx/infra/redis`      | `Bun.RedisClient`, named connections, pub/sub                     | [Database](../../docs/guide/14-database.md)                 |
| `@dunx/infra/queue`      | **bullmq** over `Bun.RedisClient`: handlers, publisher, worker    | [Queues](../../docs/guide/15-queues.md)                     |
| `@dunx/infra/schedule`   | `Bun.cron` and timers: `@Cron`, `@Interval`, `@OnceOnBoot`        | [Scheduling](../../docs/guide/16-scheduling.md)             |
| `@dunx/infra/files`      | One `Storage` contract over `Bun.file` and `Bun.S3Client`         | [Files and images](../../docs/guide/18-files-and-images.md) |
| `@dunx/infra/images`     | An immutable pipeline over `Bun.Image`                            | [Files and images](../../docs/guide/18-files-and-images.md) |
| `@dunx/infra/logger`     | **`@arkv/logger`** bound to core's `Logger` contract              | [Logging](../../docs/guide/13-logging.md)                   |
| `@dunx/infra/pagination` | Keyset pagination: cursor codec, options parser, drizzle query    | [Database](../../docs/guide/14-database.md)                 |

## Usage

```ts
import { Module } from '@dunx/core';
import { DbModule, SqliteOptions } from '@dunx/infra/db';
import { RedisModule } from '@dunx/infra/redis';
import * as schema from './schema.js';

@Module({
  imports: [
    DbModule.forRoot(new SqliteOptions({ schema, filename: './app.db' })),
    // No url: Bun resolves $VALKEY_URL, then $REDIS_URL, then localhost.
    RedisModule.forRoot({ maxRetries: 0 }),
  ],
})
export class InfraModule {}
```

Every area also has a `forRootAsync`, which is `forRoot` with a factory in front
of it. It exists for the one thing a zero-argument function cannot do: inject, so
the url or the filename can come off `ConfigService`.

## Two conventions

**Anything injectable by a constructor parameter is a runtime class, never an
interface**, because an interface erases and leaves nothing for `@dunx/transform`
to record.

It is an abstract class where dunx owns the contract (`Storage`, `DbConnection`,
`ImagesOptions`) and the library's own class where it does not
(`BunSQLiteDatabase`, `ContextStore`). The two `token()` exports,
`redisConnection(name)` and `LoggerSettings`, name things no class can.

**If an area is in the root barrel at all, all of it is.** `/db` and `/queue` are
the two the barrel does not re-export: each reaches an optional peer through a
static import, so exporting them would make `drizzle-orm` and `ioredis` hard
requirements of `import '@dunx/infra'`. Reach them at their subpaths.

**Query timing is off unless asked for.** `DbModule.forRoot(options, { metrics:
true })` binds a `QueryMetrics` and wraps the driver dunx constructs. Drizzle's
`logger` option cannot supply a duration: `logQuery` fires before the statement
runs and has no completion callback. See
[Metrics](../../docs/guide/22-metrics.md).

## Verified against

Bun 1.4.0, drizzle-orm 0.45.2 and bullmq 6.0.5. Bun's documentation is incomplete
across every area here, so the behaviour was measured rather than read. The
evidence is in [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) and
[docs/bun-apis.md](../../docs/bun-apis.md).

## License

MIT
