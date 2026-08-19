# @dunx/infra

Infrastructure for dunx: databases, Redis/Valkey, queues, file storage, images and
logging. Six areas, one package.

Where Bun ships the primitive, the primitive is what runs: `Bun.SQL`,
`bun:sqlite`, `Bun.RedisClient`, `Bun.file`, `Bun.write`, `Bun.Glob`,
`Bun.S3Client`, `Bun.Image`. No `pg`, no `better-sqlite3`, no `ioredis`, no
`@aws-sdk`, no `glob`, no `sharp`.

Three areas do not hand-roll an abstraction, because a mature library already owns
one, and each of those libraries drives a Bun API underneath. `drizzle-orm` and
`bullmq` are **optional peer dependencies**, so an app using only `/files`
installs neither.

## The seven subpaths

| Subpath              | What it is                                                      | Depth                                          |
| -------------------- | --------------------------------------------------------------- | ---------------------------------------------- |
| `@dunx/infra/db`     | **drizzle** over `bun:sqlite` and `Bun.SQL`, transactions, seeds | [Database](../../docs/guide/14-database.md)    |
| `@dunx/infra/redis`  | `Bun.RedisClient`, named connections, pub/sub                    | this file                                      |
| `@dunx/infra/queue`  | **bullmq** over `Bun.RedisClient`: handlers, publisher, worker   | [Queues](../../docs/guide/15-queues.md)        |
| `@dunx/infra/files`  | One `Storage` contract over `Bun.file` and `Bun.S3Client`        | [Files and images](../../docs/guide/17-files-and-images.md) |
| `@dunx/infra/images` | An immutable pipeline over `Bun.Image`                           | [Files and images](../../docs/guide/17-files-and-images.md) |
| `@dunx/infra/logger` | **`@arkv/logger`** bound to core's `Logger` contract             | [Logging](../../docs/guide/13-logging.md)      |
| `@dunx/infra/pagination` | Keyset pagination: cursor codec, options parser, drizzle query | this file                                  |
| `@dunx/infra/schedule` | `Bun.cron` and Bun's timers: `@Cron`, `@Interval`, `@OnceOnBoot`, a registry | this file                    |

Import from the barrel or from an area subpath. The subpaths exist so it is
obvious what a file uses, and so tree-shaking is not something you have to reason
about.

The rule, so which barrel has a symbol is never a guess: **if an area is in the
root barrel at all, all of it is** - `@dunx/infra/db` and `@dunx/infra` name the
same set.

`/queue` is the one area the barrel does **not** re-export. bullmq's
own entry point statically imports `ioredis`, so exporting it from the root would
make both a hard requirement of `import '@dunx/infra'`, including for an app that
has no queue. Reach it at `@dunx/infra/queue`. `src/index.test.ts` holds both
halves of that to account.

## Two conventions that run through all six

**Anything injectable by a constructor parameter is a runtime class here, never
an interface**, because an `interface` erases and leaves nothing for
`@dunx/transform` to record. It is an abstract class where dunx owns the
contract (`Storage`, `DbConnection`, `ImagesOptions`, `Logger`) and the
library's own class where it does not (`BunSQLiteDatabase`, `ContextStore`).

The two `token()` exports, `redisConnection(name)` and `LoggerSettings`, name
things no class can, so they are reached with `inject()` or a factory's
`inject` list.

**A `forRootAsync` is never a second mechanism.** dunx resolves eagerly and settles
every async factory before any constructor runs, so it is `forRoot` with a factory
in front of it, and it exists for the one thing a zero-argument function cannot
do: inject.

## db

drizzle is the database layer rather than one option among several. What a repository
injects is drizzle's own database class, and every query is drizzle's query
builder.

```ts
import { DbModule, SqliteOptions } from '@dunx/infra/db';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema.js';

@Module({
  imports: [DbModule.forRoot(new SqliteOptions({ schema, filename: './dev.db' }))],
  providers: [Widgets],
})
export class DatabaseModule {}

export class Widgets {
  constructor(private readonly db: BunSQLiteDatabase<typeof schema>) {}
}
```

What this package adds is the four things a drizzle handle has none of:

| Export                  | Why it exists                                                       |
| ----------------------- | ------------------------------------------------------------------- |
| `DbModule.forRoot(...)` | Opens the driver at boot, before any constructor, and binds 3 tokens |
| `DbConnection`          | `close()`, `onShutdown()`, `backend`, `dialect`, and `raw`           |
| `transaction(db, fn)`   | drizzle's own cannot roll back an async callback on `bun:sqlite`     |
| `runSeeds(db, options)` | Seeding *data*, which `drizzle-kit` has no concept of                |

drizzle's own `casing` and `logger` are on both backends' init - they extend
`DrizzleInit` and are forwarded to `drizzle()` verbatim - so `casing: 'snake_case'`
and a query logger are reachable without opening the handle by hand.

Postgres is `SqlOptions`, synchronous SQLite is `SyncSqliteOptions`, and MySQL is
`drizzle-orm/mysql-proxy` over `Bun.SQL`, worked through in
`examples/databases/src/mysql/driver.ts`.
**[Read the Database guide](../../docs/guide/14-database.md)** for all of it,
including what synchronous mode actually measures at.

## redis

Redis/Valkey on `Bun.RedisClient`.

```ts
import { RedisConnection, RedisModule } from '@dunx/infra/redis';

@Module({
  imports: [RedisModule.forRoot({ url: 'redis://localhost:6379' })],
  providers: [Sessions],
})
export class CacheModule {}

export class Sessions {
  constructor(private readonly redis: RedisConnection) {}

  async touch(id: string): Promise<void> {
    await this.redis.set(`session:${id}`, Date.now(), { ex: 3600 });
  }
}
```

`forRoot()` binds `RedisConnection` and `RedisOptions`. With no `url` it follows
Bun's own chain: `$VALKEY_URL`, then `$REDIS_URL`, then `valkey://localhost:6379`.
The URL is validated when the module is configured, because Bun accepts an
unparseable one and only fails later as an opaque `Connection closed`.

Connections are **lazy**: nothing is dialled until the first command, so an
unavailable cache does not stop the process booting. `eager: true` connects and
`PING`s during `onInit` instead, and `onShutdown` closes the socket.

### A connection that may be absent must set `maxRetries: 0`

With retries enabled, a `Bun.RedisClient` that never connects keeps an internal
timer alive **after `close()`** and the process never exits. It is a Bun-level
bug: `RedisConnection.onShutdown` cannot reach the timer, so the option is the
only mitigation. See [docs/bun-apis.md](../../docs/bun-apis.md).

`maxRetries: 0` does not cover every case. A connect to an address that neither
accepts nor refuses it - a dropped SYN rather than a closed port - leaks past
`close()` whatever the options say, and there is no workaround at all. A refused
port and a healthy server are both clean. Same file.

### Named connections

A named registration binds `redisConnection(name)` and does not also
claim `RedisConnection`, so any number of them coexist with one default. The token
is memoised, and because a token is not a constructor type it is reached with
`inject()`:

```ts
RedisModule.forRoot({ url: jobsUrl, name: 'jobs' });

export class JobQueue {
  private readonly redis = inject(redisConnection('jobs'));
}
```

### Commands

A curated subset of the roughly 250 methods on `Bun.RedisClient`: strings, keys,
counters, expiry, bulk, hashes, lists, sets and pub/sub. `SET` takes an options
object instead of Bun's positional overloads, and anything not wrapped is one
`send()` away, typed `unknown` rather than Bun's `any`:

```ts
await redis.set(key, value, { ex: 60, nx: true }); // null when the key existed
const count = (await redis.send('EXISTS', ['a', 'b'])) as number;
```

Every failure is a `RedisError extends AppError` carrying the failing command and
Bun's `code`. Bun raises some of these **synchronously**, so the wrapper catches
around the call rather than only the await, and you only ever see a rejection.
`RedisErrorCode.INVALID_RESPONSE` is the counter-intuitive one: Bun uses it for
errors the *server* returned, so `WRONGTYPE` and `ERR unknown command` arrive
under it.

### Pub/sub, and what Bun cannot do

`subscribe()` opens a **second connection**, lazily, on first use. That is not an
optimisation: a `Bun.RedisClient` in subscriber mode rejects every data command
with `ERR_REDIS_INVALID_STATE`, so sharing one socket would mean a single
`subscribe()` silently broke every `get` and `set` in the process.

Two limitations found by probing Bun 1.3.14 rather than reading its docs.
**`PSUBSCRIBE` is unusable**: passing a listener throws `ERR_INVALID_ARG_TYPE`,
and passing patterns alone returns a promise that never settles, so there is no
pattern subscription here and `send()` cannot rescue it.

And **`exists()` is single-key**, because Bun coerces Redis's integer reply to
a boolean; use `send('EXISTS', keys)` for a count. The rest, including which
prototype methods are missing from `bun-types`, is in
[docs/bun-apis.md](../../docs/bun-apis.md).

## queue

bullmq is the queue. A handler is a method with a decorator and nothing else: no
class decorator, no registry, no queue token.

```ts
import { JobHandler, QueueModule } from '@dunx/infra/queue';
import type { Job } from 'bullmq';

@Module({
  imports: [QueueModule.forRoot({ url: 'valkey://localhost:6379' })],
  providers: [Emails, Mailer],
})
export class JobsModule {}

export class Emails {
  constructor(private readonly mailer: Mailer) {}

  @JobHandler({ queue: 'emails', name: 'welcome' })
  async welcome(job: Job<{ to: string }>): Promise<void> {
    await this.mailer.send(job.data.to, 'Welcome');
  }
}
```

`forRoot()` binds the **publish** side alone: `QueueOptions`, `QueueConnection`
and `JobPublisher`. Importing it opens no worker and consumes nothing. Consuming
is `WorkerFactory.create(root)` in its own process, or `WorkerFactory.attach(app,
root)` inside a container that already exists.

**[Read the Queues guide](../../docs/guide/15-queues.md)** before deploying this.
It covers the publish/consume split, handler discovery, `jobTimeoutMs`, shutdown
ordering, the ioredis boundary, and **a known shutdown defect** you should know about.

## files

One storage contract, two backends, on `Bun.file`, `Bun.write`, `Bun.Glob` and
`Bun.S3Client`.

```ts
import { FilesModule, LocalStorageOptions, Storage } from '@dunx/infra/files';

@Module({
  imports: [FilesModule.forRoot(new LocalStorageOptions('/var/lib/app/data'))],
  providers: [Uploads],
})
export class StorageModule {}

export class Uploads {
  constructor(private readonly storage: Storage) {}

  async save(name: string, body: ReadableStream<Uint8Array>): Promise<number> {
    return this.storage.write(`uploads/${name}`, body);
  }
}
```

`Storage` is an abstract class, so it is both the injectable contract and the
token. Whether the bytes land on a disk or in a bucket is decided in one `forRoot`
call, and nothing above changes:

```ts
FilesModule.forRoot(
  new S3StorageOptions({ bucket: 'invoices', region: 'eu-west-1' }, 'tenant-a'),
);
```

Nine methods: `read`, `readBytes`, `readStream`, `write`, `exists`, `delete`,
`list`, `stat`, `presign`. Path traversal raises `PathTraversalError` before
any syscall, and nothing buffers a whole file to satisfy the contract.

**[Read the Files and images guide](../../docs/guide/17-files-and-images.md)**
for the traversal rules and their one known gap, listing behaviour, presigning,
and why streaming has to go through a sink.

## images

Decode, inspect and transform images on `Bun.Image`. No native module to install.

```ts
import { ImageFit, Images, ImagesModule } from '@dunx/infra/images';

@Module({ imports: [ImagesModule.forRoot({ quality: 85, maxWidth: 2048 })] })
export class PicturesModule {}

export class Thumbnails {
  constructor(private readonly images: Images) {}

  async card(upload: Blob): Promise<string> {
    const source = await this.images.load(upload);
    return source
      .resize(320, 320, { fit: ImageFit.INSIDE, withoutEnlargement: true })
      .to('webp', { quality: 78 })
      .toDataUrl();
  }
}
```

Two things to carry away. **The pipeline is immutable**, unlike `Bun.Image`,
which mutates and returns `this`. And **`metadata()` is not a validity check**:
it reads the header only, so a truncated file still reports its declared
dimensions, and `verify()` is the one that decodes.

**[Read the Files and images guide](../../docs/guide/17-files-and-images.md)**
for the operations, terminals, error taxonomy, and the measured `Bun.Image`
behaviour that is not in Bun's own docs.

## logger

`@arkv/logger`, bound to the `Logger` contract that lives in `@dunx/core`. dunx
supplies the contract and the wiring and **restates none of the configuration**.

```ts
import { Logger, LogLevel, Module } from '@dunx/core';
import { LoggerModule } from '@dunx/infra/logger';

@Module({
  imports: [LoggerModule.forRoot({ level: LogLevel.DEBUG, maskFields: ['ssn'] })],
  providers: [Users],
})
export class AppModule {}

export class Users {
  constructor(private readonly logger: Logger) {}

  create(email: string): void {
    this.logger.info('user created', { email, password: 'hunter2' });
    // {"level":"info","timestamp":"...","message":"user created",
    //  "email":"...","password":"[MASKED]"}
  }
}
```

Masking is upstream's sanitizer rather than a dunx reimplementation. One
structured JSON line either way; `isDevelopment` (default
`NODE_ENV !== 'production'`) only decides whether it is ANSI-coloured.

`forRoot` binds four tokens:

| Token            | Is                                                                     |
| ---------------- | ---------------------------------------------------------------------- |
| `Logger`         | `@dunx/core`'s contract, backed by `@arkv/logger`'s implementation      |
| `BackingLogger`  | The same instance, typed as the implementation: `child`, `flush`, `close` |
| `LoggerSettings` | The `LoggerConfig` it was configured with, so a factory can read it     |
| `ContextStore`   | `@arkv/logger`'s async-context store, also bound as `RequestContext`    |

There is **no adapter class between them**. `@arkv/logger`'s `Logger` already
declares `logLevel` and all six levels with the same overloads, so it satisfies
the abstract class structurally.

Configuration is `@arkv/logger`'s own `LoggerConfig`, verbatim. Read its README
for what each field does; a parallel table here would be the duplication the
reuse-`@arkv` rule exists to prevent.

**[Read the Logging guide](../../docs/guide/13-logging.md)** for the contract, the
default `ConsoleLogger` and its buffering trade, request logging, transports and
what all of it measures at.

## schedule

`@Cron`, `@Interval` and `@OnceOnBoot` on `Bun.cron` and Bun's timers. No cron
library: `Bun.cron.parse` is the parser.

`@Cron` takes `Bun.CronWithAutocomplete`, so Bun's named schedules are accepted and
offered by an editor: `@Cron('@daily')` alongside `@Cron('0 3 * * *')`. All seven
(`@yearly`, `@annually`, `@monthly`, `@weekly`, `@daily`, `@midnight`, `@hourly`)
parse on 1.3.14. `CronExpression` holds the same seven as values, for a config
object that cannot carry a literal.

```ts
import {
  Cron,
  CronExpression,
  Interval,
  OnceOnBoot,
  Overlap,
  ScheduleModule,
  ScheduleRegistry,
} from '@dunx/infra/schedule';

export class ReportsService {
  constructor(private readonly reports: ReportsRepository) {}

  @Cron('0 3 * * *')
  async nightly(): Promise<void> {
    await this.reports.rebuild();
  }

  @Interval(30_000, { name: 'probe', overlap: Overlap.SKIP })
  async probe(): Promise<void> {}

  @Cron(CronExpression.HOURLY)
  async rollUp(): Promise<void> {}

  @OnceOnBoot(5_000)
  warmCache(): void {}
}

@Module({ imports: [ScheduleModule.forRoot()], providers: [ReportsService] })
export class AppModule {}
```

A schedule is declared in `@Module({ providers })`, or on a controller, like any
other injectable, and found by its marker. There is no second registration and no
class decorator, and an abstract base's marked methods are inherited by every
subclass. The name defaults to `ClassName.methodName`; two schedules under one
name is a boot error.

**In-process and single-node.** Two replicas both run every schedule, because
nothing here coordinates. A schedule that must fire once across a fleet is a job:
that is bullmq's `upsertJobScheduler` through `@dunx/infra/queue`.

`ScheduleRegistry` is exported, and `trigger(name)` runs a schedule off its
cadence. `Bun.cron` fires at minute resolution, so `trigger` is also how a
schedule is tested without waiting for a boundary.

```ts
const registry = app.get(ScheduleRegistry);
await registry.trigger('ReportsService.nightly');
registry.list(); // name, kind, at, tz, runs, running, lastError, nextRunAt
registry.remove('probe');
```

**Overlap.** `Overlap.SKIP` is the default. A fire that lands while a run is going
is skipped and logged at `warn` with the name and how long the run has been going.
For a `@Cron` this is `Bun.cron`'s own guarantee, which computes the next fire only
once the handler settles. There is no queue mode: an overrun that must not be
dropped is a job.

**Timezones, and a trap.** A `@Cron` takes `{ tz }`, validated against
`@arkv/timezones` at decoration time so a typo is a boot error rather than a
schedule that never fires at the hour it names.

Bun 1.3.14 **silently ignores** `Bun.cron`'s `tz` option, and does not declare it
in bun-types either. Asking for a named zone there is refused outright: it would
otherwise run at the UTC hour with no error anywhere. `supportsTz()` is exported
for an app that would rather fail its own boot on that.

dunx always passes `{ tz: 'UTC' }` explicitly. That is correct on both sides of
Bun's 1.4 change: 1.3.x ignores the option and is already UTC, and 1.4 honours it
and pins UTC rather than drifting to the container's `TZ`.

**`@Interval` and `@OnceOnBoot` are measured from `onInit`,** which is the latest hook
there is and runs *before* `Bun.serve` binds. So `@OnceOnBoot(0)` fires before the
socket is open. An app needing the later point uses
`ScheduleModule.forRoot({ enabled: false })` and calls `registry.add` after
`listen()`.

A delay above 2,147,483,647 ms is a boot error. Bun clamps anything larger to 1 ms
and fires it at about 17 ms, so it would be a hot loop rather than a long wait.

## pagination

Keyset pagination, the kind that stays correct while rows are being
written.

```ts
import {
  paginate,
  parsePageOptions,
  PAGINATION,
  CursorError,
  type Page,
} from '@dunx/infra/pagination';

export class NotesService {
  constructor(private readonly db: SyncSqliteConnection) {}

  list(query: Record<string, unknown>): Promise<Page<Note>> {
    return paginate<typeof notes, Note>({
      db: this.db.client,
      table: notes,
      options: parsePageOptions(query),
    });
  }
}
```

```json
{
  "data": [{ "id": "n_9", "title": "newest" }],
  "meta": {
    "take": 20,
    "hasNextPage": true,
    "hasPreviousPage": false,
    "nextCursor": "eyJzIjoiMjAyNi0wMS0wMlQwMzowNDowNS4wMDBaIiwiaSI6Im5fOSJ9",
    "previousCursor": null
  }
}
```

### Why keyset and not `OFFSET`

An offset scan re-reads and discards every row before the page, so page 500
costs 500 pages of work. Worse, it is wrong under writes: insert a row while
someone is reading, and every later page shifts by one, so an item is served
twice or skipped entirely.

A cursor names the last row seen, the database seeks straight to it, and a
concurrent insert changes nothing about what has already been read. There is a
test for exactly that.

The cursor carries the sort value **and** the row id, and the query compares both.
Without the id tie-break, rows sharing a timestamp are silently skipped or
repeated, and a bulk insert produces exactly that.

### What it does not do

- **No `zod` schema.** `parsePageOptions` is a hand-written validator, because this
  package has no validation dependency and route validation targets Standard Schema
  - shipping a zod schema would pick the library for you. Build one from
  `PAGINATION` if you want the OpenAPI document, the same way
  `ConfigModule.forRoot({ validate })` leaves the choice open.
- **No total count.** `hasNextPage` comes from fetching one row more than asked and
  dropping it, so there is no second `COUNT(*)` over the same predicate. A total is a
  separate query when you genuinely need one.
- **No HTTP error.** A bad cursor throws `CursorError` and bad options throw
  `PageOptionsError`, both `AppError`s - this package must not depend on the web
  layer, so mapping them to a 400 is the caller's.

`paginate` takes anything with drizzle's `select()`, so both dialects and a
transaction handle fit. It `await`s the builder rather than calling `.all()`:
drizzle's builders are thenable on the synchronous `bun:sqlite` driver as well as
the asynchronous `Bun.SQL` one, measured, so one code path serves both.

## Verified against

Bun 1.3.14, drizzle-orm 0.45.2 and bullmq 6.0.5. Bun's documentation is incomplete
across every area here, so the behaviour these pages describe was **measured
rather than read**. The evidence is in
[docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md) and
[docs/bun-apis.md](../../docs/bun-apis.md).
