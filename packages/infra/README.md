# @dunx/infra

Infrastructure for dunx: databases, Redis/Valkey, queues, file storage, images and
logging. Six areas, one package.

Where Bun ships the primitive, the primitive is what runs: `Bun.SQL`,
`bun:sqlite`, `Bun.RedisClient`, `Bun.file`, `Bun.write`, `Bun.Glob`,
`Bun.S3Client`, `Bun.Image`. No `pg`, no `better-sqlite3`, no `ioredis`, no
`@aws-sdk`, no `glob`, no `sharp`.

Three areas do not hand-roll an abstraction, because a mature library already owns
one — and each of those libraries drives a Bun API underneath:

- **`/db` is drizzle.** `drizzle-orm/bun-sqlite` over `bun:sqlite`, or
  `drizzle-orm/bun-sql` over `Bun.SQL`. `drizzle-orm` is an **optional peer
  dependency**, so an app using only `/files` never installs it.
- **`/queue` is bullmq**, running on `Bun.RedisClient` through bullmq's own
  `createBunRedisClient`. dunx contributes handler discovery, injection and
  shutdown ordering — not retries, backoff, rate limiting or scheduling.
  `bullmq` is an **optional peer dependency** too.
- **`/logger` is `@arkv/logger`**, bound to the `Logger` contract that lives in
  `@dunx/core`. The contract and the wiring are dunx's; the configuration, the
  sanitizer and the async context store are upstream's.

Import from the barrel or from an area subpath — the subpaths exist so it is
obvious what a file uses, and so tree-shaking is not something you have to reason
about:

```ts
import { DbModule, SqliteOptions } from '@dunx/infra/db';
import { RedisConnection } from '@dunx/infra/redis';
import { JobHandler, QueueModule } from '@dunx/infra/queue';
import { Storage, LocalStorageOptions } from '@dunx/infra/files';
import { Images } from '@dunx/infra/images';
import { LoggerModule } from '@dunx/infra/logger';

// or, everything, from one place
import { DbModule, Images, LoggerModule, RedisConnection, Storage } from '@dunx/infra';
```

`/queue` is the one area the barrel deliberately does **not** re-export. bullmq's
own entry point statically imports `ioredis`, so exporting it from the root would
make both a hard requirement of `import '@dunx/infra'` — including for an app that
has no queue. Reach it at `@dunx/infra/queue`.

Anything injectable by a **constructor parameter** is a runtime class here, never
an interface: an `interface` erases and leaves nothing for `@dunx/compiler` to
record as a parameter type. It is an abstract class where dunx owns the contract —
`Storage`, `DbConnection`, `DbOptions`, `ImagesOptions`, `Logger` — and the
library's own class where it does not (`BunSQLiteDatabase`, `ContextStore`). The
`token()` calls in the package are the exceptions that prove the rule:
`redisConnection('jobs')` names a *second* connection, which no class can, and
`LoggerSettings` names a config type owned upstream. Neither is nameable as a
constructor parameter, so both are reached with `inject()` or a factory's `inject`
list.

And a `forRootAsync` is never a second mechanism: dunx resolves eagerly and settles
every async factory before any constructor runs, so it is `forRoot` with a factory
in front of it.

## db — `@dunx/infra/db`

**drizzle is the database layer**, not one option among several. What a repository
injects is drizzle's own database class, and every query is drizzle's query
builder. This package adds no query abstraction over it — there is no `Database`
contract, no `db.sql` template, no `Repository` base class.

What it does add is the four things a drizzle handle has none of:

| Export                  | Why it exists                                                        |
| ----------------------- | -------------------------------------------------------------------- |
| `DbModule.forRoot(…)`   | Opens the driver at boot, before any constructor, and binds 3 tokens  |
| `DbConnection`          | `close()`, `onShutdown()`, `backend`, `dialect`, and `raw`            |
| `transaction(db, fn)`   | drizzle's own cannot roll back an async callback on `bun:sqlite`      |
| `runSeeds(db, options)` | Seeding _data_, which `drizzle-kit` has no concept of                 |

### Setup

```ts
import { Module } from '@dunx/core';
import { DbModule, SqliteOptions } from '@dunx/infra/db';
import * as schema from './schema.js';

@Module({
  imports: [
    DbModule.forRoot(new SqliteOptions({ schema, filename: './dev.db' })),
  ],
  providers: [UsersRepository],
})
export class AppModule {}
```

`schema` is **required**, and the reason it is: it is the type argument that
reaches `BunSQLiteDatabase<typeof schema>` at every injection site, so a table
added to the schema module is visible in every repository without being registered
anywhere. Pass `{}` if you only ever run `sql` templates.

```ts
import { eq } from 'drizzle-orm';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import * as schema from './schema.js';
import { users, type User } from './schema.js';

export class UsersRepository {
  constructor(private readonly db: BunSQLiteDatabase<typeof schema>) {}

  findByEmail(email: string): User | undefined {
    return this.db.select().from(users).where(eq(users.email, email)).get();
  }
}
```

Two things about that annotation. The import is a **value** import, not
`import type`: `@dunx/compiler` records the constructor parameter's type name and
the container resolves it as a token, so a type-only import would be recorded as
`unresolved` and fail at boot. And the token is the **erased** class — the
compiler records `BunSQLiteDatabase` and ignores the type argument, which is what
lets one runtime class be the token while the schema types survive on the
annotation.

### Two backends, and they are not interchangeable

An earlier version of this package had a hand-rolled `Database` abstract class that
both backends satisfied, and this section claimed "two backends, one contract". It
no longer holds. drizzle already _is_ that abstraction, and its two adapters are
not source-compatible with each other, so a contract spanning them could only hide
the differences:

|                 | `SqliteOptions`                              | `SqlOptions`                       |
| --------------- | -------------------------------------------- | ---------------------------------- |
| drizzle adapter | `drizzle-orm/bun-sqlite`                     | `drizzle-orm/bun-sql`              |
| Driver          | `bun:sqlite`                                 | `Bun.SQL`                          |
| Dialect         | SQLite                                       | **Postgres only**                  |
| Injected as     | `BunSQLiteDatabase<typeof schema>`           | `BunSQLDatabase<typeof schema>`    |
| Builders        | synchronous — `.run()` / `.all()` / `.get()` | asynchronous — `await` the builder |
| Raw SQL         | `db.run` / `db.all` / `db.get`               | `db.execute`                       |
| Schema tables   | `sqliteTable`                                | `pgTable`                          |
| Connection      | one embedded handle                          | pooled, over a socket              |
| Server          | none                                         | one has to be running              |

Schema modules are per dialect too — a `sqliteTable` is a compile error where a
`PgTable` is expected. So which backend an app uses is a build-time decision, and
"one `DATABASE_URL` naming either SQLite or Postgres" is not a shape this package
supports any more.

#### `SqlOptions` is Postgres only

`Bun.SQL` speaks four dialects: `postgres`, `mysql`, `mariadb`, `sqlite` — that
list is quoted from Bun's own rejection message. `drizzle-orm/bun-sql` speaks
**one**. Its `driver.js` builds `new PgDialect({ casing: config.casing })`
unconditionally; there is no branch on `client.options.adapter` anywhere in it.

So a non-Postgres URL is refused at construction rather than at connect time:

```ts
new SqlOptions({ schema, url: 'mysql://localhost/app' });
// DatabaseError: "mysql://localhost/app" names mysql, and drizzle-orm/bun-sql is
// Postgres only — it builds a PgDialect unconditionally, so a non-Postgres URL
// would compile $1 placeholders and Postgres quoting against a server that does
// not speak them. Use SqliteOptions for SQLite; MySQL and MariaDB have no
// drizzle driver on Bun.SQL.
```

Pointed at a `sqlite://` client it would not error at all — it would compile `$1`
placeholders and `"quoted"` identifiers against SQLite, and the trivial cases
would appear to work. That is worse than failing, and it is why the check exists.

**MySQL and MariaDB therefore have no drizzle path on Bun.** `Bun.SQL` reaches
them, but nothing in drizzle drives `Bun.SQL` as anything other than Postgres, and
drizzle's own MySQL adapters need `mysql2` — a client Bun already replaces, so this
package does not ship one.

`dialectFromUrl` is what decides, and it is deliberately stricter than Bun: Bun
reads a _schemeless_ string as a Postgres host, so `{ url: './dev.db' }` reports
`adapter: 'postgres'` and then fails much later with a socket error. `pg://` is not
a scheme Bun accepts; `postgres://`, `postgresql://`, `sqlite:` and `file:` are.

### Querying

drizzle's builder, unchanged. On `bun:sqlite` it is **synchronous**, so a statement
ends in `.run()`, `.all()` or `.get()`; on Postgres, awaiting the builder is what
executes it.

```ts
db.insert(users).values({ email }).run();
const rows = db.select().from(users).orderBy(users.id).limit(10).all();
const one = db.select().from(users).where(eq(users.id, id)).get();
const total = db.select({ n: count() }).from(users).get()?.n ?? 0;
```

`.get()` returns **`undefined`** when there is no row — drizzle's choice, and worth
knowing if you are coming from a wrapper that returned `null`. `.returning()` hands
back the row the database actually wrote.

Repository methods are still worth declaring `async` on `bun:sqlite`: callers await
them anyway, and moving that table to Postgres later then costs no signature
change.

Raw SQL is where the two adapters share nothing at all. bun-sqlite has
`run`/`all`/`get`/`values` and no `execute`; bun-sql has `execute` and none of the
others:

```ts
import { sql } from 'drizzle-orm';

// bun-sqlite
db.run(sql`PRAGMA foreign_keys = ON`);
const counted = db.all<{ n: number }>(sql`SELECT count(*) AS n FROM users`);
const first = db.get<{ n: number }>(sql`SELECT count(*) AS n FROM users`);

// bun-sql
await pg.execute(sql`CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY)`);
```

Anything meant to work on both has to branch on the handle, which is exactly what
`runSeeds` does internally.

#### `Date` is **not** normalised for you

An earlier version of this file said it was. It is not, and on a non-strict handle
the failure is **silent**, so this is the paragraph to read twice.

A `Date` interpolated into a `sql` template reaches the driver untouched, and
SQLite has no date type to receive it. Measured on Bun 1.3.14 with drizzle-orm
0.45.2:

```ts
db.run(sql`INSERT INTO audit (at) VALUES (${new Date()})`);
// strict: true  (this package's default) -> DrizzleError, cause: Missing parameter "1"
// strict: false                          -> no error at all, and the column holds NULL
```

`bun:sqlite` reads a single object binding as a named-parameter map, which is why a
strict handle reports a _missing_ parameter rather than a bad one, and why an
unstrict one writes `NULL` for a binding it cannot use. Called with a positional
array instead, the same driver states it plainly:
`TypeError: Binding expected string, TypedArray, boolean, number, bigint or null`.

That is why `strict: true` is this package's default, unlike the driver's — it
turns the silent `NULL` into a throw. It is also why `SqliteOptions` opens the
`bun:sqlite` handle itself instead of letting `drizzle('./dev.db')` do it: drizzle's
own path forwards only `readonly`/`create`/`readwrite` and hands back a
**non-strict** handle.

Two ways to write a timestamp, both verified. Pick one per column — they store
different things:

```ts
// 1. A TEXT column and a raw template: convert it yourself.
db.run(sql`INSERT INTO logins (at) VALUES (${new Date().toISOString()})`);

// 2. A column that declares its mode, and the builder. drizzle maps both ways.
export const audit = sqliteTable('audit', {
  at: integer('at', { mode: 'timestamp' }).notNull(), // stored as epoch seconds
});

db.insert(audit).values({ at: new Date() }).run();
db.select().from(audit).get()?.at; // a Date back out
```

The mapping belongs to the **column**, so it applies to the builder and never to a
`sql` template — which is also the trap: a raw `INSERT` of an ISO string into a
`{ mode: 'timestamp' }` column stores text where the reader expects epoch seconds,
and SQLite will not stop you. `runSeeds` sidesteps it by declaring `applied_at` as
`TEXT` and writing an ISO string, since it only ever uses raw SQL.

Postgres is the exception, not the rule here: it parses a `timestamptz` from the
string and, per [docs/bun-apis.md](../../docs/bun-apis.md), takes a native `Date`
binding as well. So a `sql` template written against SQLite is the one that breaks,
and the one this package's `strict: true` default is aimed at. Worth knowing if you
reach for `Bun.SQL` directly: its **SQLite** adapter has no strict switch and
silently writes `NULL` for a `Date`, with no error at all — which is a second reason
`SqlOptions` refuses a `sqlite://` URL.

### Transactions — `transaction(db, fn)`

A standalone function rather than a method, because on one of the two backends it
replaces drizzle's own:

```ts
import { transaction } from '@dunx/infra/db';

const id = await transaction(db, async (tx) => {
  const row = tx.insert(users).values({ email }).returning().get();
  await Bun.sleep(1); // still inside the transaction
  tx.insert(audit).values({ userId: row.id, at: new Date() }).run();
  return row.id;
});
```

Commit on return, roll back on throw, and the throw propagates. Nesting takes a
savepoint, so an inner failure unwinds only the inner work:

```ts
await transaction(db, async (tx) => {
  tx.insert(users).values({ email: 'kept@example.com' }).run();
  await transaction(tx, async (sp) => {
    sp.insert(users).values({ email: 'dropped@example.com' }).run();
    throw new Error('unwinds to the savepoint only');
  }).catch(() => {});
});
```

#### Why this is not `db.transaction()`

On `bun:sqlite`, because drizzle's is synchronous. `drizzle-orm/bun-sqlite`'s
session hands the callback straight to `bun:sqlite`'s own wrapper:

```js
const nativeTx = this.client.transaction(() => {
  result = transaction(tx);
});
nativeTx[config.behavior ?? 'deferred']();
```

That wrapper commits as soon as the callback **returns its promise**, so
`client.inTransaction` is already `false` before the first `await` resumes, every
statement after it runs in autocommit, and a later throw rolls back nothing.
Measured on Bun 1.3.14: insert, `await Bun.sleep(1)`, throw, catch — the row is
still there. drizzle inherits the behaviour rather than fixing it, which is why
`transaction()` issues `BEGIN`/`COMMIT`/`ROLLBACK` itself.

There is only one connection, so two overlapping top-level transactions would issue
a nested `BEGIN`. They queue instead. A nested call is already inside the holder's
turn and takes a savepoint, so it must not queue behind itself.

On **Postgres** this delegates to drizzle's `db.transaction()`, which is genuinely
async — it goes through `Bun.SQL`'s `begin()`, and that reserves a connection for
the duration. The handle the callback gets there is drizzle's `PgTransaction`
(exported as `SqlTransaction<TSchema>`), not the database, because the pooled outer
handle would take a different connection and sit outside the transaction. Nesting
on Postgres is therefore `tx.transaction(...)` — drizzle's own savepoint — since
this function's Postgres overload takes the database:

```ts
await transaction(pg, async (tx) => {
  await tx.execute(sql`INSERT INTO audit (user_id) VALUES (1)`);
  await tx.transaction(async (sp) => {
    await sp.execute(sql`INSERT INTO audit (user_id) VALUES (2)`);
  });
});
```

### Seeding — `runSeeds`

Data, not schema. Schema changes are `drizzle-kit generate` plus
`drizzle-orm/bun-sqlite/migrator` (sync) or `drizzle-orm/bun-sql/migrator`
(async); drizzle-kit owns the SQL, its own journal, and the snapshot folder. What
it has no concept of is _data_, which is what this is for — and why its journal
table is separate from drizzle's.

```ts
import { runSeeds } from '@dunx/infra/db';

const report = await runSeeds(db, { dir: `${import.meta.dir}/seeds` });
report.applied; // journaled by this run, in the order they ran
report.journaled; // already recorded, so not run again
report.skipped; // refused by their own when(env)
```

A seed file exports `seed`, and optionally `when`:

```ts
// seeds/0001_users.seeder.ts
export const when = (env: string): boolean => env !== 'production';

export function seed(db: BunSQLiteDatabase<typeof schema>): void {
  db.insert(users).values({ email: 'ada@example.com' }).run();
}
```

- **Order is the numeric prefix**, not the filename, so `0010_x` runs after
  `0009_x`. A file without one is an error, and so are two files sharing a number:
  the whole value of a journal is that the order is identical everywhere, and a tie
  would be settled by whatever order `Bun.Glob` happened to scan in.
- **One transaction per seed**, covering the seed _and_ its journal row. A seed that
  throws leaves neither the data nor the record, so it is retried on the next boot
  instead of being half-applied and marked done. On `bun:sqlite` that transaction is
  this package's, for the reason above.
- **A `when(env)` refusal is not journaled.** It lands in `skipped` and writes no
  row, so the same file still runs the first time it reaches an environment it does
  belong in. `env` defaults to `NODE_ENV`, then `'development'`.
- The journal table defaults to `dunx_seeds` and is created `IF NOT EXISTS` on
  every call, so it is safe on every boot. `applied_at` is `TEXT` on SQLite and
  `TIMESTAMPTZ` on Postgres, written as an ISO 8601 **string** either way — because
  of the `Date` refusal above, and because Postgres parses the string anyway.
- The default pattern is `*.seeder.{ts,js}`: Bun runs TypeScript directly, and a
  build emits JS.

The handle a seed receives is the transaction's, which on `bun:sqlite` _is_ the
database (one connection) and on Postgres is a `PgTransaction`. `SeedHandle<TSchema>`
is the union; a seed file annotates the one it was written for, since a body that
names tables is dialect-specific regardless.

### Options are classes

So they are injectable — `constructor(private readonly options: DbOptions)` works,
and `options.dialect` is how something stays dialect-aware without knowing which
module configured it.

```ts
new SqliteOptions({
  schema, // required
  filename: './dev.db', // ':memory:', a path, or a sqlite:/file: URL
  pragmas: ['journal_mode = WAL'], // run once, at open, before the first query
  strict: true, // default here, unlike the driver
  safeIntegers: false,
  readOnly: false,
});

new SqlOptions({
  schema,
  url: Bun.env['DATABASE_URL'] ?? 'postgres://localhost:5432/app',
  max: 10,
  idleTimeout: 30,
});
```

`SqlInit` extends `Bun.SQL.PostgresOrMySQLOptions`, so pooling, TLS and auth stay
in sync with whatever Bun supports rather than being restated here. `url` becomes
required and `adapter` is dropped, since the scheme already decides it. Neither
`schema` nor `url` rides along into the driver options — a schema object is every
table and column in the app.

One `SqliteInit` option does not do what it says, recorded rather than papered
over. `create: false` does **not** stop a missing file being created — verified
through `SqliteOptions` on Bun 1.3.14, where `{ strict: true, create: false }`
opens and creates. (`{ create: false }` on its own throws `SQLITE_MISUSE` even for a
file that exists, which is why `strict` is always sent.) Use `readOnly` when the
file has to already exist: that one refuses correctly, with
`unable to open database file`.

### `forRoot` and `forRootAsync`

```ts
DbModule.forRoot(new SqliteOptions({ schema, filename: ':memory:' }));

DbModule.forRootAsync(BunSQLiteDatabase, {
  useFactory: (config: Config) =>
    new SqliteOptions({ schema, filename: config.databaseFile }),
  inject: [Config],
});
```

`forRootAsync` takes **the token first**, unlike every other `forRootAsync` in this
package. drizzle's database class is the injection token, and which class that is
only becomes known once the factory has produced the options — too late to register
a provider under it. So it has to be named up front.

Both bind **three** tokens:

| Token                                  | Is                                          |
| -------------------------------------- | ------------------------------------------- |
| `DbOptions`                            | the resolved configuration                  |
| `DbConnection`                         | the lifecycle and the raw driver handle      |
| `BunSQLiteDatabase` / `BunSQLDatabase` | drizzle's handle — what a repository injects |

The drizzle handle is bound through a factory that depends on `DbConnection`, and
that is what fixes the shutdown order: dunx tears down in reverse construction
order, so the connection — constructed first, because everything else needs it —
closes last. Because every factory settles before the first constructor runs, the
connection is open, handshaked and pragma'd by the time the first repository is
built. No lazy connect, no `await db.ready()`.

### Shutdown

`DbConnection` implements `OnShutdown` and `close()` is idempotent, so
`enableShutdownHooks()` is the whole of it:

```ts
const app = await AppFactory.create(AppModule);
app.enableShutdownHooks();
await app.closed;
```

Shutdown runs in reverse construction order, so every repository has drained while
the connection was still usable.

One thing this deliberately does not do: guard queries after `close()`. drizzle
holds no state and cannot be asked whether its driver is open, and wrapping every
method to find out would be the query abstraction this package exists without. A
query issued after shutdown therefore surfaces as the driver's own error —
`DrizzleError`, `cause: Cannot use a closed database` — not a `DatabaseError`
explaining itself. `SqliteConnection.closed` / `SqlConnection.closed` is where that
fact lives if you need to branch on it.

### The raw handle — `connection.raw`

Anything backend-specific is one narrowing away. `raw` is `unknown` on
`DbConnection` because the base cannot promise either driver:

```ts
import { DbConnection, SqlConnection, SqliteConnection } from '@dunx/infra/db';

export class Snapshots {
  constructor(private readonly connection: DbConnection) {}

  async take(): Promise<Uint8Array | undefined> {
    if (this.connection instanceof SqliteConnection) {
      return this.connection.raw.serialize(); // bun:sqlite Database
    }
    if (this.connection instanceof SqlConnection) {
      await this.connection.raw.begin('read write', async () => {
        /* the Bun.SQL client itself */
      });
    }
    return undefined;
  }
}
```

`serialize()`, `deserialize()`, `loadExtension()` and `iterate()` are `bun:sqlite`
capabilities drizzle does not surface, and this is the door to them (`strict`,
`safeIntegers` and `PRAGMA` are already `SqliteInit` options, because they have to be
set at open time). The `Bun.SQL` client is itself a function — it _is_ the tagged
template — so
`typeof raw === 'function'`. Note that its SQLite adapter does not support
`reserve()`: _"This adapter doesn't support connection reservation"_.

### No entity decorators

`@Entity('users')` with `@Column()` fields was measured and rejected. TC39
decorators are **type-transparent** in TypeScript: a decorator's return type does
not become the declaration's type, so it can attach a runtime value but cannot tell
the type system the value is there. On TypeScript 7.0.2 both a `defineProperty`'d
static and a `C & { table }` return type fail with
`TS2339: Property 'table' does not exist`.

drizzle's whole value is that the table object's _type_ carries column types into
every query. A decorator could have built a working table at runtime while every
query degraded to `unknown`, and recovering the types would mean hand-writing a
mapped type mirroring drizzle's `BuildColumns` — a second source of truth that
drifts from the first, which is the duplication decorators were meant to remove.
drizzle's native `sqliteTable` / `pgTable` object schema is the supported path.

The measurement is in [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md), under
**Verified constraints** — "A decorator cannot publish a type back onto the class
it decorates".

### Testing

`bun:sqlite` at `:memory:` needs no server, so point `DbModule` at it and test
against a real database:

```ts
const app = await AppFactory.create(
  DbModule.forRoot(new SqliteOptions({ schema, filename: ':memory:' })),
);
const db = app.get(BunSQLiteDatabase);
```

The Postgres backend has no equivalent trick, and an earlier version of this
package claimed one: it ran its `Bun.SQL` suite over that driver's SQLite adapter.
That is invalid now. `drizzle-orm/bun-sql` would compile `$1` placeholders and
Postgres quoting against SQLite, the trivial cases would pass, and a green suite
would be proving nothing — worse than a red one. So the offline `SqlOptions` tests
cover URL handling, driver options and token identity only, and everything that
needs the wire skips unless `DUNX_DB_TEST_URL` names a reachable Postgres.

## redis — `@dunx/infra/redis`

> **A connection that may be absent must set `maxRetries: 0`.** With retries
> enabled, a `Bun.RedisClient` that never connects keeps an internal timer alive
> **after `close()`** and the process never exits. It is a Bun-level bug —
> `RedisConnection.onShutdown` cannot reach the timer — so the option is the only
> mitigation. See `docs/bun-apis.md`.


Redis/Valkey on `Bun.RedisClient`.

```ts
import { RedisConnection } from '@dunx/infra/redis';

export class SessionsService {
  constructor(private readonly redis: RedisConnection) {}

  async touch(id: string): Promise<void> {
    await this.redis.set(`session:${id}`, Date.now(), { ex: 3600 });
  }
}
```

### Setup

```ts
import { AppFactory, Module } from '@dunx/core';
import { RedisModule } from '@dunx/infra/redis';

@Module({
  imports: [RedisModule.forRoot({ url: 'redis://localhost:6379' })],
  providers: [SessionsService],
})
class AppModule {}

const app = (await AppFactory.create(AppModule)).enableShutdownHooks();
```

`forRoot()` binds `RedisConnection` and `RedisOptions`. With no `url` it follows
Bun's own chain: `$VALKEY_URL`, then `$REDIS_URL`, then `valkey://localhost:6379`.

Configuration that has to be fetched goes through `forRootAsync`:

```ts
RedisModule.forRootAsync(async () => ({ url: await secrets.get('REDIS_URL') }));
```

#### Options

| Option                 | Default                                                  | Notes                                   |
| ---------------------- | -------------------------------------------------------- | --------------------------------------- |
| `url`                  | `$VALKEY_URL` → `$REDIS_URL` → `valkey://localhost:6379` | Validated when the module is configured |
| `name`                 | —                                                        | Binds `redisConnection(name)` instead   |
| `eager`                | `false`                                                  | Connect and `PING` during `onInit`      |
| `connectionTimeout`    | `10000`                                                  |                                         |
| `idleTimeout`          | `0`                                                      |                                         |
| `autoReconnect`        | `true`                                                   |                                         |
| `maxRetries`           | `10`                                                     |                                         |
| `enableOfflineQueue`   | `true`                                                   |                                         |
| `enableAutoPipelining` | `true`                                                   |                                         |
| `tls`                  | —                                                        | `boolean` or `Bun.TLSOptions`           |

Connections are lazy: nothing is dialled until the first command, so an
unavailable cache does not stop the process from booting. Set `eager: true` when
you would rather find out at startup. `onShutdown` closes the socket, so
`enableShutdownHooks()` is all the cleanup there is.

### Named connections

```ts
@Module({
  imports: [
    RedisModule.forRoot({ url: cacheUrl }),
    RedisModule.forRoot({ url: jobsUrl, name: 'jobs' }),
  ],
})
class AppModule {}
```

A named registration binds `redisConnection('jobs')` and deliberately does _not_
also claim `RedisConnection`, so any number of them can coexist with one default.
Because a token is not a constructor type, reach a named connection with `inject()`
rather than a constructor parameter:

```ts
import { inject } from '@dunx/core';
import { redisConnection } from '@dunx/infra/redis';

export class JobQueue {
  private readonly redis = inject(redisConnection('jobs'));
}
```

`redisConnection(name)` is memoised, so the same name always yields the same token.

### Commands

The surface is a curated subset of the ~250 methods on `Bun.RedisClient`: strings
(`get`, `set`, `getdel`, `append`, `strlen`), keys (`del`, `exists`, `type`, `keys`,
`scan`, `rename`), counters (`incr`, `incrby`, `decr`, `decrby`), expiry (`expire`,
`pexpire`, `ttl`, `pttl`, `persist`), bulk (`mget`, `mset`), hashes (`hget`, `hset`,
`hmget`, `hgetall`, `hdel`, `hexists`, `hkeys`, `hvals`, `hlen`, `hincrby`), lists
(`lpush`, `rpush`, `lpop`, `rpop`, `lrange`, `llen`, `lindex`, `lrem`, `ltrim`),
sets (`sadd`, `srem`, `smembers`, `sismember`, `scard`), and pub/sub (`publish`,
`subscribe`, `unsubscribe`).

`SET` takes an options object instead of Bun's positional overloads:

```ts
await redis.set(key, value, { ex: 60, nx: true }); // null when the key existed
await redis.set(key, value, { get: true }); // the previous value
```

Anything not wrapped is one `send()` away, typed `unknown` rather than Bun's `any`:

```ts
const count = (await redis.send('EXISTS', ['a', 'b'])) as number;
await redis.send('ZADD', ['leaderboard', 1, 'ada']);
```

### Errors

Every failure is a `RedisError extends AppError`, carrying the failing command and
Bun's `code`:

```ts
import { isConnectionError, RedisError, RedisErrorCode } from '@dunx/infra/redis';

try {
  await redis.get(key);
} catch (error) {
  if (isConnectionError(error)) return fallback;
  throw error;
}
```

Bun raises some of these **synchronously** — a data command issued while the
connection is in subscriber mode throws rather than rejecting — so the wrapper
catches around the call, not just the await, and you only ever see a rejection.

`RedisErrorCode.INVALID_RESPONSE` is the counter-intuitive one: Bun uses it for
errors the _server_ returned, so `WRONGTYPE` and `ERR unknown command` both arrive
under it. The response parsed fine; the command was wrong.

### Pub/sub

`subscribe()` opens a **second connection**, lazily, on first use:

```ts
await redis.subscribe('events', (message, channel) => {
  console.log(channel, message);
});
await redis.set('still', 'works'); // fine — different socket
```

This is not an optimisation. A `Bun.RedisClient` in subscriber mode rejects every
data command with `ERR_REDIS_INVALID_STATE`, so sharing one socket would mean a
single `subscribe()` call silently broke every `get` and `set` in the process.
`unsubscribe(channel)` drops all listeners on it, `unsubscribe(channel, listener)`
just the one.

### Limitations

Found by probing Bun 1.3.14, not from its docs:

- **`PSUBSCRIBE` is unusable.** `Bun.RedisClient.prototype.psubscribe` exists and is
  absent from `bun-types`. Passing a listener throws `ERR_INVALID_ARG_TYPE`
  (it accepts only strings and buffers), and passing patterns alone returns a
  promise that **never settles**. There is no pattern subscription here as a result,
  and `send('PSUBSCRIBE', …)` will not help — the reply has nowhere to be delivered.
- **`exists()` is single-key.** Bun coerces Redis's integer reply to a boolean, so a
  multi-key call cannot tell "one of three" from "three of three". Use
  `send('EXISTS', keys)` for a count.
- **`enableOfflineQueue: false` needs an explicit connect.** With no queue to hold
  the first command during the handshake, a lazily issued one is rejected with
  `Connection is closed and offline queue is disabled` even against a healthy
  server. Pair it with `eager: true`, which connects before it pings.
- **Bun accepts an unparseable URL** and only fails later, at connect time, as an
  opaque `Connection closed`. `RedisOptions` validates the URL and its protocol
  while the module is being configured instead.
- `psubscribe`, `punsubscribe`, `pubsub`, `script`, and `select` are all on the
  prototype but missing from `bun-types`. Of those, `pubsub`, `script`, and `select`
  do work — reach them through `send()`.
- Buffer-valued subscriptions are not implemented by Bun; listeners get strings.
- Transactions (`MULTI`/`EXEC`) and Lua (`EVAL`) have no wrapper. `send()` works for
  `EVAL`; `MULTI` needs command-ordering guarantees that `enableAutoPipelining`
  makes unsafe to assume.

### Testing without a server

The integration suite probes the server first and skips itself when nothing
answers, so `bun test` passes on a machine with no Redis. Unit coverage of option
handling, module wiring, error mapping, and lifecycle needs no server at all —
`Bun.RedisClient` connects lazily, so a container can be built and torn down
against an address that is never dialled.

## queue — `@dunx/infra/queue`

**bullmq is the queue.** dunx adds no retry policy, no backoff, no rate limiter, no
scheduler — those are bullmq's, and a second implementation of them would be a
worse one. What this area adds is the four things bullmq has no opinion about:
where a handler lives, how it is found, how it is injected, and when it stops.

```ts
import type { Job } from 'bullmq';
import { JobHandler } from '@dunx/infra/queue';

export class Emails {
  constructor(private readonly mailer: Mailer) {}

  // The whole registration. No class decorator, no registry, no queue token.
  @JobHandler({ queue: 'emails', name: 'welcome' })
  async welcome(job: Job<{ to: string }>): Promise<{ sent: string }> {
    await this.mailer.send(job.data.to, 'Welcome');
    return { sent: job.data.to };
  }
}
```

```bash
bun add bullmq ioredis
```

### Two things to know before you deploy this

**Connections are bounded by default** — `{ connectionTimeout: 5000, maxRetries: 0 }`,
overridable through `connection`. Bun's own defaults retry without bound, which turns
an unreachable Redis into a route that never answers instead of one that fails. With
the default, `publish()` rejects in single-digit milliseconds and a controller can map
it to a 503.

**A process that attempted a queue operation while Redis was unreachable will not
exit on `SIGTERM`.** bullmq creates its connection on first use and holds a handle
whose retry timer outlives `close()`; `maxRetries: 0` does not clear it, because the
handle is bullmq's rather than Bun's and nothing in userland can reach it.

Measured, and the trigger is narrow — importing the module is not enough:

| Redis | Published? | `SIGTERM` |
| ----- | ---------- | --------- |
| unreachable | no  | exits in ~1 s |
| unreachable | yes | **never exits** |
| reachable   | yes | exits in ~2 s |

So a healthy deployment is unaffected, and an app that imports `QueueModule` without
publishing is unaffected. What hangs is a process that served a queue route while
Redis was down. It serves correctly throughout — 503 in single-digit milliseconds —
so this is a shutdown defect, not an availability one. Evidence in
[docs/bun-apis.md](../../docs/bun-apis.md).

Both are **optional peer dependencies**, so an app using only `/files` installs
neither. `ioredis` is there for bullmq's sake, not dunx's — see
[The ioredis boundary](#the-ioredis-boundary).

### Setup

One module, imported by every process that touches a queue:

```ts
import { AppFactory, Module } from '@dunx/core';
import { QueueModule } from '@dunx/infra/queue';

@Module({
  imports: [QueueModule.forRoot({ url: 'valkey://localhost:6379' })],
  providers: [Emails, Mailer],
})
export class AppModule {}
```

`forRoot()` binds `QueueOptions`, `QueueConnection` and `JobPublisher` — the
**publish** side, which is all a web process needs. Importing it opens no worker and
consumes nothing. With no `url` it follows the same chain `/redis` does: `$VALKEY_URL`,
then `$REDIS_URL`, then `valkey://localhost:6379`. `forRootAsync({ useFactory, inject })`
is the same thing with the options behind a factory that may await and may inject.

#### Options

| Option              | Default                                                  | Notes                                                    |
| ------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| `url`               | `$VALKEY_URL` → `$REDIS_URL` → `valkey://localhost:6379` | Validated when the module is configured                  |
| `prefix`            | `'bull'`                                                 | bullmq's key prefix                                      |
| `worker`            | `{}`                                                     | Forwarded verbatim to every `Worker`                     |
| `defaultJobOptions` | —                                                        | Forwarded verbatim as every `Queue`'s `defaultJobOptions` |
| `jobTimeoutMs`      | —                                                        | Not a bullmq feature. See below                          |

`worker` and `defaultJobOptions` are **passthroughs on purpose**. `concurrency`,
`limiter`, `lockDuration`, `stalledInterval`, `attempts`, `backoff`,
`removeOnComplete` and the rest are bullmq's own options, documented by bullmq;
restating them here would only produce a staler copy.

### Publishing

```ts
export class Signups {
  constructor(private readonly jobs: JobPublisher) {}

  async register(email: string): Promise<void> {
    await this.jobs.publish('emails', 'welcome', { to: email });
  }
}
```

`publish(queue, name, data, options?)` returns bullmq's own `Job`, and
`publisher.queue(name)` returns bullmq's own `Queue` — with `addBulk`,
`upsertJobScheduler`, `getJobCounts`, `drain` and everything else already on it.
There is no wrapper to outgrow.

A queue is opened on first use, not declared up front: a queue is a key prefix, not
a resource to reserve, so there is nothing a registration step could validate.
`onShutdown` closes every queue that was opened.

### Consuming — the worker process

A worker is a separate process running `WorkerFactory`:

```ts
// worker.ts
import { WorkerFactory } from '@dunx/infra/queue';
import { AppModule } from './app.module.js';

const worker = await WorkerFactory.create(AppModule);
await worker.start();
worker.enableShutdownHooks();
await worker.closed;
```

```json
{ "scripts": { "worker": "bun run src/worker.ts" } }
```

The root module it is handed may be the app's own or a narrower one that leaves the
controllers out — it is a normal dunx container either way, so a handler gets the
same constructor injection a controller does.

`create` discovers and validates; `start` is what opens connections. So a wiring
mistake — no `QueueModule`, no handlers, a misspelled name in `queues` — fails
before anything consumes, and `worker.jobs` can be inspected in a test without a
server running.

`WorkerFactory.create(AppModule, { queues: ['emails'] })` consumes a subset, which
is how one queue gets its own process and its own concurrency. A name in that list
that no handler claims is a boot error rather than a process that quietly serves
only the queues that were spelled right.

### How a handler is found

The same **marker-plus-prototype-scan** routes and websocket gateways use. `@JobHandler`
sets a symbol property on the method function it receives and returns it; nothing is
recorded anywhere else. At boot `WorkerFactory` walks the prototype chain of the
classes the modules already declare, and a marked method is a job. See
[ARCHITECTURE.md](../../docs/ARCHITECTURE.md), "Route discovery", for why it is not
an accumulator.

What follows from that:

- **No second registration.** A handler's class is declared in
  `@Module({ providers })` — or `controllers` — like any other injectable. There is
  no `registerQueue`, no `@Processor` class decorator and no queue token to inject.
- **A handler may be inherited.** An abstract base's marked method is found on every
  subclass, and overriding it *without* re-decorating still works — the marker is on
  the base's function, and dispatch is bound off the instance, so it lands on the
  override.
- **Two handlers for one `(queue, name)` is a boot error** naming both, because it
  would otherwise silently split the traffic between them.
- **A factory- or value-provided instance is not scanned.** There is no class to read
  a prototype chain from until it has been built. Put handlers on a class provider.

An arriving job whose name no handler claims fails with a message saying what that
worker *does* serve — the shape of the bug is usually a worker deployed ahead of the
handler that serves it, and bullmq retries it under the job's own `attempts`.

### `jobTimeoutMs`

bullmq has `lockDuration` and stall detection, which answer *did the worker die*, not
*is this handler stuck*. A handler hung on an external call holds its lock, renews it,
and never finishes. `jobTimeoutMs` rejects it so the job fails and retries. Off by
default; it is the one behaviour here that bullmq does not already own.

### Shutdown

`worker.shutdown()` closes every bullmq `Worker` **before** the container tears down.
That order is the point: `close()` without `force` stops fetching and waits for what
is already running, so an in-flight job finishes while the database connection it is
using is still open. The container's own reverse-construction-order teardown then
closes the publisher's queues, and last of all the sockets — `QueueConnection` is
constructed first, because everything else needs it, so it goes last.

`enableShutdownHooks()` wires SIGTERM and SIGINT to that sequence.

### The ioredis boundary

Rule 1 bans `ioredis` for dunx's own code, because `Bun.RedisClient` exists. bullmq
needs *a* Redis client. The resolution is not a compromise:

**Every byte of queue traffic goes through `Bun.RedisClient`.** bullmq accepts either
a connection description it builds a client from, or an already-built client
implementing its `IRedisClient` interface — and bullmq 6 ships
`createBunRedisClient`, an adapter over Bun's client. `QueueConnection` uses it. dunx
neither imports nor constructs ioredis, and `@dunx/infra/redis` is untouched: a
queue's sockets are its own, one per bullmq object.

ioredis must still be **installed**, because bullmq 6.0.5's barrel statically imports
it from `redis-connection` even when nothing in that path runs. That is bullmq's
packaging, measured rather than assumed, and it is why `ioredis` is listed as an
optional peer here at all. Nothing in dunx reaches for it.

### Testing with no Redis running

The integration suite probes the server first and skips itself when nothing answers,
so `bun test` passes on a machine with no Redis. Discovery, dispatch, options and
module wiring need no server at all: `create` opens no socket, so a container can be
built, inspected and torn down against an address that is never dialled.

## files — `@dunx/infra/files`

One storage contract, two backends, on `Bun.file`, `Bun.write`, `Bun.Glob` and
`Bun.S3Client`.

```ts
export class Uploads {
  constructor(private readonly storage: Storage) {}

  async save(name: string, body: ReadableStream<Uint8Array>) {
    return this.storage.write(`uploads/${name}`, body);
  }
}
```

`Storage` is an abstract class, so it is both the injectable contract and the
token. Whether the bytes land on a disk or in a bucket is decided in one
`forRoot` call — nothing above changes.

### Setup

```ts
import { AppFactory, Module } from '@dunx/core';
import { FilesModule, LocalStorageOptions } from '@dunx/infra/files';

@Module({
  imports: [FilesModule.forRoot(new LocalStorageOptions('/var/lib/app/data'))],
  providers: [Uploads],
})
class AppModule {}

const app = await AppFactory.create(AppModule);
```

S3 — or R2, or MinIO, or Spaces — is the same call with different options:

```ts
import { FilesModule, S3StorageOptions } from '@dunx/infra/files';

FilesModule.forRoot(
  new S3StorageOptions(
    { bucket: 'invoices', region: 'eu-west-1' },
    'tenant-a', // optional key prefix
  ),
);
```

Anything omitted from the client options falls back to the environment —
`S3_BUCKET`/`AWS_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_REGION`, `AWS_ENDPOINT`. That is `Bun.S3Client`'s own resolution; this
package adds none of its own.

`forRootAsync` when the configuration has to be loaded, or injected:

```ts
FilesModule.forRootAsync({
  useFactory: (config: AppConfig) => new LocalStorageOptions(config.dataDir),
  inject: [AppConfig],
});
```

Both bind the same two tokens: `Storage`, and the `StorageOptions` that selected
it.

### The contract

```ts
abstract class Storage {
  read(key: string): Promise<string>;
  readBytes(key: string): Promise<Uint8Array>;
  readStream(key: string): Promise<ReadableStream<Uint8Array>>;
  write(key: string, data: WriteData): Promise<number>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(options?: ListOptions): AsyncIterable<ListEntry>;
  stat(key: string): Promise<FileStat>;
  presign(key: string, options?: PresignOptions): string;
}
```

`write` takes a `string`, `Uint8Array`, `ArrayBuffer`, `Blob`, or
`ReadableStream`, and returns the byte count. `delete` is idempotent on both
backends — removing a key that was never there is not an error. A missing key
raises `FileNotFoundError` whichever backend you are on.

`list` is an `AsyncIterable`, so a bucket with a million objects is paged rather
than accumulated:

```ts
for await (const entry of storage.list({ prefix: 'reports', glob: '*.csv' })) {
  console.log(entry.key);
}
```

Keys are always relative to the storage root — the configured directory locally,
the configured prefix on S3. What `write` takes is what `list` and `stat` give
back, so putting a bucket behind a prefix does not ripple into call sites.

#### presign

S3 signs; a local disk cannot. `LocalStorage.presign()` throws
`UnsupportedOperationError` naming the key and what to do instead, rather than
returning a URL that does not work:

```
LocalStorage does not support presign(). Nothing signs "report.pdf" on a local
disk. Configure S3StorageOptions, or serve the bytes through your own route.
```

Signing is HMAC over the canonical request, so `S3Storage.presign()` is
synchronous and never touches the network.

### Path traversal is rejected, not sanitised

Every key is resolved against the configured root, and one that lands outside it
raises `PathTraversalError` before any syscall:

```ts
await storage.read('../../etc/passwd'); // PathTraversalError
```

That covers `../`, an absolute key, an empty key, and the root itself. A key is
accepted or refused identically on every platform: `..\..\etc` is one legal
filename to POSIX but three segments to Windows, so `..` is checked as a segment
on both separators before the path is resolved at all. S3 keys get the same
treatment — a key is opaque to S3, so a `..` in one was meant as a path, and
under a prefix it would escape it.

One thing this does not do: `resolve` collapses segments textually, so a symlink
**inside** the root pointing outside it is still followed. Detecting that needs
`realpath`, which cannot answer for a file that does not exist yet. Do not make
the root writable by anything you would not trust with its contents.

### Streaming stays streaming

Nothing here buffers a whole file to satisfy the contract. `readStream` returns
`Bun.file().stream()` (or the S3 `GET` body) unread, and a `ReadableStream`
passed to `write` is pumped chunk by chunk into a sink — `FileSink` locally, a
multipart `NetworkSink` on S3. A file larger than memory transfers either way.

Two things forced the sink rather than `Bun.write`, both measured on Bun 1.3.14:

- `Bun.write(path, stream)` matches no overload and silently persists the string
  `"[object ReadableStream]"` — 23 bytes where a file was expected.
- `Bun.write(path, new Response(stream))` never settles when the response body is
  itself a stream.

A `FileSink` also neither creates parent directories nor truncates — it writes
over the existing bytes from offset 0 and leaves any tail in place — so a
streaming local write does an empty `Bun.write` first to do both jobs, then
streams in over the top.

Two places where a call costs more than it looks:

- `readStream` does one `exists()` first, so a missing key rejects the promise
  instead of handing back a stream that fails on the consumer's first `read()`.
  On S3 that is one extra `HEAD`.
- `list({ glob })` on S3 lists by prefix and applies the pattern to the keys that
  come back, because S3 has no glob. The page size is therefore not capped by
  `limit` when a glob is in play — capping it would truncate before the filter
  ran.

### Listing details worth knowing

- Local listings include dotfiles. S3 has no notion of a hidden object, so
  neither does this.
- Order is whatever the backend gives: lexicographic on S3, filesystem order for
  a glob scan. Sorting would mean buffering the whole listing.
- `size` and `lastModified` on a `ListEntry` are set only when the backend hands
  them over with the listing. S3 does; a glob scan does not, and statting every
  hit would turn one listing into N syscalls. Call `stat()` when you need them.
- A prefix that does not exist lists as empty on both backends rather than
  raising.

## images — `@dunx/infra/images`

Decode, inspect and transform images on `Bun.Image`. No native module install.

```ts
@Module({ imports: [ImagesModule.forRoot({ quality: 85, maxWidth: 2048 })] })
export class AppModule {}

export class Thumbnails {
  constructor(private readonly images: Images) {}

  async card(upload: Blob): Promise<string> {
    const source = await this.images.load(upload);
    return source
      .resize(320, 320, { fit: 'inside', withoutEnlargement: true })
      .to('webp', { quality: 78 })
      .toDataUrl();
  }
}
```

### Sources

`load()` takes a `BunFile`, a `Blob`, an `ArrayBuffer`, a `Uint8Array`, a
`Buffer`, a filesystem path, or a `data:` URL, and normalises all of them to
bytes. A `Response` or a `ReadableStream` is refused with
`ERR_IMAGE_UNREADABLE_SOURCE` — call `.blob()` first.

### Format detection is content-based

The container is decided by magic bytes, never by a filename. A `.png` holding
JPEG bytes reports `jpeg`:

```ts
const pipeline = await images.load('avatar.png');
pipeline.format; // 'jpeg'
```

`sniffFormat(bytes)` is the same check as a free function, and
`images.supports(bytes)` folds it together with the configured `allowedFormats`.

### The pipeline is immutable

```ts
const source = await images.load(bytes);
const thumb = source.resize(64, 64); // source is unchanged
const hero = source.resize(1200); // and still 'source'
```

`Bun.Image` mutates and returns `this`, so two callers holding one instance
silently reconfigure each other. An `ImagePipeline` returns a new value from
every operation, can be shared and forked freely, and re-runs the whole recipe
from the original bytes on each terminal.

Operations: `resize`, `rotate`, `flip`, `flop`, `modulate`, `to`.
Terminals: `encode`, `toBytes`, `toBuffer`, `toBlob`, `toBase64`, `toDataUrl`,
`toFile`, `placeholder`, `sourceMetadata`.

`encode()` is the one that reports real output dimensions:

```ts
const { bytes, format, mimeType, width, height } = await pipeline.encode();
```

### Errors

Everything throws `ImageError extends AppError`, carrying a `code` and the
original throw as `cause`:

```ts
try {
  await images.verify(upload);
} catch (error) {
  if (error instanceof ImageError && error.code === ImageErrorCode.DECODE_FAILED) {
    // truncated or corrupted payload
  }
}
```

Bun's own codes pass through unchanged (`ERR_IMAGE_UNKNOWN_FORMAT`,
`ERR_IMAGE_DECODE_FAILED`, `ERR_IMAGE_FORMAT_UNSUPPORTED`,
`ERR_IMAGE_TOO_MANY_PIXELS`, `ERR_INVALID_ARG_TYPE`). Two are added here:
`ERR_IMAGE_UNREADABLE_SOURCE` for a source that could not be read at all, and
`ERR_IMAGE_FORMAT_NOT_ALLOWED` for one excluded by `allowedFormats`.

### `metadata()` is not a validity check

This is the sharpest edge in the whole API. `Bun.Image.metadata()` answers from
the container header and never decodes pixels, so a **truncated file still
reports its declared dimensions**:

```ts
await images.metadata(halfAFile); // { width: 64, height: 48, format: 'png' } — resolves!
await images.verify(halfAFile); // throws ImageError ERR_IMAGE_DECODE_FAILED
```

Use `metadata()` when you want the cheap header read, and `verify()` when the
pixels have to be known-good. `verify()` runs a full decode.

### Configuration

`ImagesOptions` is an `abstract class`, so it is a usable injection token — an
`interface` would erase and `@dunx/compiler` would record the parameter as
unresolved.

| Option           | Default                   | Effect                                           |
| ---------------- | ------------------------- | ------------------------------------------------ |
| `quality`        | `80`                      | Encoder quality when a call does not override it  |
| `maxPixels`      | `0x3fff * 0x3fff`         | Reject a source over this, before pixel alloc    |
| `autoOrient`     | `true`                    | Apply the JPEG EXIF `Orientation` tag first      |
| `allowedFormats` | every container Bun reads | Gates both decoding and encoding                 |
| `maxWidth`       | `undefined`               | Clamps every requested resize width              |
| `maxHeight`      | `undefined`               | Clamps every requested resize height             |

There is no `forRootAsync`. dunx resolves eagerly and settles factories before
any constructor runs, so pass a function and it is awaited:

```ts
ImagesModule.forRoot(async () => ({ quality: await settings.imageQuality() }));
```

`Images` is bound through an explicit factory, so this area works with or without
the `@dunx/compiler` preload. You still need the preload for your _own_ classes to
inject `Images` by constructor.

### What `Bun.Image` actually does

`Bun.Image` is barely documented upstream. Everything below was measured on Bun
1.3.14, and the surprises are pinned by tests in this package.

**Lazy, and re-runnable.** The constructor and every chainable only record
settings; the decode/transform/encode pipeline runs on a worker thread when a
terminal is awaited. Awaiting a second terminal on the same instance re-runs it
rather than throwing — there is no consumed state. Parallel terminals via
`Promise.all` on one instance are safe.

**Chainables mutate and overwrite.** They return `this`, not a clone, and
calling one twice keeps only the last call. Execution order is fixed at
`autoOrient -> rotate -> flip/flop -> resize -> modulate` regardless of the
order you called them in.

**`metadata()` ignores the chain.** It returns `{ width, height, format }` for
the **source** — `new Bun.Image(x).resize(32, 24).metadata()` still reports the
input's 64x48 and the input's format. It also reads the header only, so it
succeeds on a truncated file.

**`width`/`height` are `-1` until a terminal has been awaited**, and then hold
whatever that terminal produced: output dimensions after `bytes`/`blob`/
`dataurl`/`toBase64`, the _source_ dimensions after `metadata()`, and the
ThumbHash's own dimensions after `placeholder()`.

**`placeholder()` also ignores the chain.** It is a ThumbHash of the source as a
`data:image/png;base64,...` URL, roughly 1.4 KB for a photo, at most 32px on the
long edge. Only `"dataurl"` is accepted as its argument.

**Decode-only formats fall back to PNG.** Bun decodes `gif` (first frame),
`bmp` and `tiff` but has no encoder for them. The docs say a terminal with no
format setter "re-encodes in the source format"; for those three it actually
emits **PNG**, and `blob().type` reports `image/png`. `tiff` decoding also fails
on Linux with `ERR_IMAGE_FORMAT_UNSUPPORTED`.

**Error taxonomy.** `Bun.Image` rejects with a plain `Error` carrying
`error.code`, except for argument validation, which is a `TypeError`:

| Condition                                    | Type        | `code`                          |
| -------------------------------------------- | ----------- | ------------------------------- |
| No container signature matched               | `Error`     | `ERR_IMAGE_UNKNOWN_FORMAT`      |
| Header valid, pixels truncated or corrupt    | `Error`     | `ERR_IMAGE_DECODE_FAILED`       |
| HEIC/AVIF/TIFF with no OS codec              | `Error`     | `ERR_IMAGE_FORMAT_UNSUPPORTED`  |
| Over `maxPixels` (raised even by `metadata`) | `Error`     | `ERR_IMAGE_TOO_MANY_PIXELS`     |
| Rotation not a multiple of 90                | `TypeError` | `ERR_INVALID_ARG_TYPE`          |
| Unknown resize `filter`                      | `TypeError` | `ERR_INVALID_ARG_TYPE`          |
| Input is a `Response`/`ReadableStream`       | `TypeError` | `ERR_INVALID_ARG_TYPE`          |
| Missing path / directory                     | `Error`     | raw syscall: `ENOENT`, `ENODEV` |

`ERR_IMAGE_ENCODE_FAILED` and `ERR_INVALID_STATE` are declared in the types but
were not reachable in probing.

**Silent clamping.** `resize(0)`, `resize(-5)` and `resize(1.5)` all produce a
1x1 image instead of throwing. `quality: 0` behaves as the minimum and
`quality: 101` as `100`. A bogus _option key_ is ignored, but a bogus option
_value_ for `filter` throws.

**Undocumented but present.** `Bun.file(path).image()` and
`Blob.prototype.image()` both exist and return a `Bun.Image`. A `data:` URL is
accepted as constructor input even though the signature only says `string` — a
plain URL is not, and is treated as a path (`ENOENT`).

**Platform.** `Bun.Image.backend` is `'bun'` on Linux and `'system'` on
macOS/Windows; assigning anything else throws a `TypeError`. On Linux the
clipboard statics are inert: `fromClipboard()` is `null`,
`hasClipboardImage()` is `false`, `clipboardChangeCount()` is `-1`. HEIC and
AVIF encoding is unavailable under the `bun` backend, and setting
`backend = 'system'` on Linux does not change that.

`linear` works as a resize filter (an alias for `bilinear`) even though it is
missing from the error message listing the valid names.

## logger — `@dunx/infra/logger`

`@arkv/logger`, bound to the `Logger` contract that lives in `@dunx/core`. dunx
supplies the contract and the wiring and **restates none of the configuration**.

```ts
import { Logger, LogLevel, Module } from '@dunx/core';
import { LoggerModule } from '@dunx/infra/logger';

export class Users {
  constructor(private readonly logger: Logger) {}

  create(email: string): void {
    this.logger.info('user created', { email, password: 'hunter2' });
    // {"level":"info","timestamp":"…","pid":…,"message":"user created",
    //  "email":"…","password":"[MASKED]"}
  }
}

@Module({
  imports: [
    LoggerModule.forRoot({ level: LogLevel.DEBUG, maskFields: ['ssn'] }),
  ],
  providers: [Users],
})
class AppModule {}
```

One structured JSON line either way; `isDevelopment` (default
`NODE_ENV !== 'production'`) only decides whether it is ANSI-coloured. Masking is
upstream's sanitizer, not a dunx reimplementation of one.

The level is `info`, and the method is `info`. `log` survives as a deprecated alias
that emits the same `"level":"info"` — upstream keeps it because NestJS's
`LoggerService` mandates the name, and the contract keeps it so that class still
satisfies it.

### The split, and why

- The **contract** — `abstract class Logger`, plus `LogLevel`, `LOG_LEVELS`,
  `isErrorLevel`, `LogEntry` and `SerializedError` — lives in **`@dunx/core`**,
  which has zero dependencies. That is what lets `@dunx/http` middleware inject
  `Logger` without pulling a logger implementation in behind it.
- The **implementation** lives here, where dependencies are normal. `@arkv/logger`
  is a plain `dependency`, not a peer: it is first-party, published, and has
  near-zero transitive weight.
- Both are re-exported from `@dunx/infra/logger`, so a consumer needs one import.

There is **no adapter class between them**. `@arkv/logger`'s `Logger` already
declares `logLevel` and all six levels with the same overloads, so it satisfies the
abstract class structurally and the entire binding is a `provide(Logger, {
useFactory })`. A wrapper would be a second surface to keep in sync, and per
CLAUDE.md a fix the logger needs belongs upstream in `@arkv` rather than in a dunx
subclass.

Because the contract is a **copy** of the level names rather than a re-export, the
two can drift — and the failure is silent, not loud. The backing logger filters by
`LOG_LEVELS.indexOf(level)`; a name it does not know yields `-1`, which sorts below
every real level, so a stale name turns level filtering into "emit everything"
instead of raising. `module.test.ts` asserts the two arrays are equal for exactly
that reason. That is the price of core staying dependency-free, and it is a test
rather than a runtime check because it can only change at build time.

`@dunx/core` previously held a full **port** of `@arkv/logger`. It is gone; the ten
sanitizer fixes it carried were published upstream as `@arkv/logger@0.8.0` instead.
`dependencies` pins `^0.8.1`, which is the release that renamed `log` to `info` and
added transports, the rotating file sink and the global error capture below.

### What `forRoot` binds

| Token            | Is                                                                      |
| ---------------- | ----------------------------------------------------------------------- |
| `Logger`         | `@dunx/core`'s contract, backed by `@arkv/logger`'s implementation       |
| `BackingLogger`  | the same instance, typed as the implementation — `child`, `flush`, `close` |
| `LoggerSettings` | the `LoggerConfig` it was configured with, so a factory can read it     |
| `ContextStore`   | `@arkv/logger`'s async-context store, shared by every logger            |

`LoggerSettings` is a `token<LoggerConfig>` rather than a class, because the config
type is upstream's — an interface, with no runtime value to name.

`BackingLogger` exists because the contract covers the six levels and nothing else.
Three things sit outside it — `child(bindings)`, `flush()` and `close()` — and this
token is how an app reaches them without a cast, and without widening the contract
for every implementation that will never have a transport to flush.

Configuration is `@arkv/logger`'s own `LoggerConfig`, verbatim: `name`, `version`,
`env`, `level`, `isDevelopment`, `maskFields`, `filterEvents`, `maxArrayLength`,
`maxDepth`, `transports`, `bindings`, `onTransportError`. Read its README for what
each does — a parallel table here is exactly the duplication the "reuse `@arkv`"
rule exists to prevent. `DEFAULT_MASK_FIELDS` is re-exported so you can see what is
already redacted before adding to it.

There is no `forRootAsync`. Pass a function, sync or async, and eager resolution
settles it before any constructor runs:

```ts
LoggerModule.forRoot(async () => ({ level: await settings.logLevel() }));
```

### Transports

`ConsoleTransport`, `FileTransport` and the `Transport` interface are re-exported.
Supplying `transports` **replaces** the default console sink, so include one
explicitly to keep stdout:

```ts
import {
  ConsoleTransport,
  FileTransport,
  LoggerModule,
  LogLevel,
} from '@dunx/infra/logger';

LoggerModule.forRoot({
  level: LogLevel.DEBUG,
  transports: [
    new ConsoleTransport(),
    new FileTransport({
      path: 'logs/app.log',
      level: LogLevel.WARN,
      interval: 'daily',
      maxFiles: 7,
      bufferBytes: 64 * 1024,
    }),
  ],
});
```

A transport's own `level` is independent of the logger's, so debug can go to the
terminal while only warnings reach disk. A transport that throws is isolated —
a full disk surfaces on `onTransportError`, never as an exception in the request
path that happened to log a line.

The second argument to `forRoot` is dunx's own, and currently holds one option:

```ts
LoggerModule.forRoot({ level: LogLevel.INFO }, { captureGlobalErrors: true });
```

That installs `uncaughtException` and `unhandledRejection` handlers which log
through this logger and flush before the process goes away, and removes them again
on shutdown. Pass upstream's `CaptureGlobalErrorsOptions` instead of `true` to keep
the process alive after an uncaught exception.

### Shutdown

`FileTransport` batches when `bufferBytes` is set, so entries can be pending when
the app stops. The module registers a lifecycle-only provider whose `onShutdown`
flushes and closes every transport — nothing an app has to remember:

```ts
const app = await AppFactory.create(AppModule);
app.enableShutdownHooks();
```

It runs late. `App.shutdown` walks instances in reverse resolution order, and the
logger resolves before anything that depends on it, so services can still log while
they close.

That provider is not an adapter — it wraps no method and forwards no call. It exists
because core's shutdown looks for `onShutdown()` and upstream's method is `close()`,
and putting `close()` on the contract would oblige every implementation to have one.

### Request context

`ContextStore` is one shared `AsyncLocalStorage`, so a correlation id set once is
merged into every entry logged inside that flow — and nothing per-request goes near
the container:

```ts
import { ContextStore } from '@dunx/infra/logger';

export class RequestScope {
  constructor(private readonly context: ContextStore) {}

  run<T>(requestId: string, fn: () => Promise<T>): Promise<T> {
    return this.context.runWithContext({ requestId }, fn);
  }
}
```

Entries logged inside `run()` carry `"requestId":"…"`; entries logged outside it do
not.

Nested scopes **merge**: an inner `runWithContext({ userId })` inherits the outer
`requestId` and overrides only the keys it names, so the field entries are most
often correlated by does not vanish one frame down. The merged context is a fresh
object, so an inner scope never leaks back out. Pass `{ inherit: false }` for a
scope that must start clean, such as a detached background job.

For static fields that are not per-request — a module or worker name — use
`child(bindings)` on `BackingLogger` instead. Per-call fields and async context both
take precedence over bindings, and the transports are shared, so close the root
logger rather than a child:

```ts
const logger = app.get(BackingLogger).child({ module: 'users' });
```

## Verified against

Bun 1.3.14, drizzle-orm 0.45.2 and bullmq 6.0.5. Bun's documentation is incomplete
across every area here, so the behaviour described above was measured rather than
read: the four
`Bun.SQL` adapters, the `affectedRows`/`count` split on result metadata, the
hardcoded `PgDialect` in `drizzle-orm/bun-sql`, the synchronous-commit behaviour of
`bun:sqlite`'s `transaction()` and drizzle's inheritance of it, the `Date` binding
refusal and the silent `NULL` a non-strict handle writes in its place, the missing
`reserve()` on the SQLite adapter, the unusable `psubscribe`, the synchronous throws
from `Bun.RedisClient` in subscriber mode, the two `Bun.write` stream failures, and
the whole `Bun.Image` section. On the bullmq side: that `createBunRedisClient` really
does carry concurrency, retries with backoff, delayed jobs and a draining `close()`;
that bullmq never closes a connection it was handed; that closing one afterwards
emits `error` on an emitter bullmq has already stopped listening to; and that
`ioredis` is a load-time requirement of the barrel despite being an optional peer.
