# Database

`@dunx/infra/db` is **drizzle**, wired into the container. It adds no query
abstraction, no entity decorators, and no repository base class. drizzle is the
interface.

What it does add is the four things a drizzle handle does not have: a lifecycle,
module wiring, an async-safe transaction, and data seeding.

```bash
bun add drizzle-orm
```

`drizzle-orm` is an **optional peer dependency**, so an app that only uses
`@dunx/infra/files` installs nothing.

## Setup

```ts
import { Module } from '@dunx/core';
import { DbModule, SqliteOptions } from '@dunx/infra/db';
import * as schema from './schema.js';

@Module({
  imports: [
    DbModule.forRoot(
      new SqliteOptions({
        schema,
        filename: './dev.db',
        pragmas: ['foreign_keys = ON'],
      }),
    ),
  ],
  providers: [Widgets],
})
export class AppModule {}
```

Then inject drizzle's own database class:

```ts
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { desc } from 'drizzle-orm';
import * as schema from './schema.js';
import { widgets, type Widget } from './schema.js';

export class Widgets {
  constructor(private readonly db: BunSQLiteDatabase<typeof schema>) {}

  async list(): Promise<readonly Widget[]> {
    return this.db.select().from(widgets).orderBy(desc(widgets.id)).all();
  }
}
```

There is no wrapper in that constructor. `BunSQLiteDatabase` and `BunSQLDatabase`
are real runtime classes, so a class is usable as a token directly, and
`@dunx/transform` records the bare type name while ignoring the type argument. One
erased class is the token; the schema types stay on the annotation.

`schema` is required, and that is why: it is the type argument that reaches
`BunSQLiteDatabase<typeof schema>` at every injection site. Pass `{}` if you only
run `sql` templates.

## What `DbModule` binds

| Token                                                   | What it is                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `DbOptions`                                             | The resolved configuration, so anything can read `dialect` |
| `DbConnection`                                          | The lifecycle and the raw driver handle                    |
| `BunSQLiteDatabase` / `BunSQLDatabase` / `SyncDatabase` | The drizzle handle a repository injects                    |

The drizzle handle is bound through a factory that depends on `DbConnection`,
which is what fixes the shutdown order. dunx tears down in reverse construction
order, so the connection is constructed first and therefore closes last, after
every repository has drained.

Every factory settles before the first constructor runs, so the connection is open
and handshaked before any repository is built. There is no lazy connect and no
`await db.ready()`.

### `forRootAsync` takes the token first

```ts
DbModule.forRootAsync(SyncDatabase, {
  useFactory: (config: AppConfigService) =>
    new SyncSqliteOptions({
      schema,
      filename: config.get('database').file,
      pragmas: ['foreign_keys = ON'],
    }),
  inject: [AppConfigService],
});
```

The token is a positional argument here, unlike `forRoot`. Which drizzle class the
handle is bound under only becomes known once the factory has produced the
options, which is too late to register a provider under it.

See [Configuration](./11-configuration.md) for why the parameter is
`AppConfigService` rather than `ConfigService<AppConfig>`.

## Two backends, and they are not interchangeable

| Options class       | Driver                         | Handle              | Dialect  |
| ------------------- | ------------------------------ | ------------------- | -------- |
| `SqliteOptions`     | `bun:sqlite`                   | `BunSQLiteDatabase` | SQLite   |
| `SyncSqliteOptions` | `bun:sqlite`, synchronous mode | `SyncDatabase`      | SQLite   |
| `SqlOptions`        | `Bun.SQL`                      | `BunSQLDatabase`    | Postgres |

Both go through drizzle's Bun-native drivers, `drizzle-orm/bun-sqlite` and
`drizzle-orm/bun-sql`. No `pg`, no `better-sqlite3`, no `postgres.js`. The library
owns the abstraction, Bun owns the I/O.

Because schema modules are dialect-specific (`sqliteTable` versus `pgTable`), the
two backends are a **build-time choice**. One `DATABASE_URL` naming either is not a
supported shape.

### Postgres

```ts
import { DbModule, SqlOptions } from '@dunx/infra/db';
import * as schema from './schema.js';

DbModule.forRoot(new SqlOptions({ schema, url, max: 4, connectionTimeout: 5 }));
```

`SqlInit` extends `Bun.SQL`'s own option type rather than restating it, so
pooling, TLS and auth stay in sync with whatever Bun supports. `url` is required
and `adapter` is dropped, because the URL scheme decides it.

The dialect is resolved from the URL **at construction**, so a bad URL throws
before any I/O. A non-Postgres URL throws with a message saying why, and the
reason is worth knowing:

> `drizzle-orm/bun-sql` builds a `PgDialect` **unconditionally**. Read from
> drizzle-orm 0.45.2's `bun-sql/driver.js`, there is no branch on
> `client.options.adapter` anywhere in the module.

Pointed at a `sqlite://` client it does not error. It compiles `$1` placeholders
and Postgres identifier quoting against SQLite, the trivial cases pass, and that
is worse than failing. So `SqlOptions` refuses.

The handshake is awaited inside `open()` rather than deferred to the first query.

### `SqliteOptions`

| Field          | Default      | Notes                                                         |
| -------------- | ------------ | ------------------------------------------------------------- |
| `schema`       | required     | The type argument that reaches every injection site           |
| `filename`     | `':memory:'` | A path, or a `sqlite:`/`file:` URL, whose scheme is stripped  |
| `readOnly`     | `false`      | Opens `SQLITE_OPEN_READONLY`, suppresses `create`             |
| `create`       | `true`       | See the caveat below                                          |
| `strict`       | `true`       | **Not the driver's default.** See below                       |
| `safeIntegers` | `false`      | Return integers as `bigint` rather than truncating to 53 bits |
| `pragmas`      | `[]`         | Run once after opening, each prefixed with `PRAGMA`           |

`pragmas` is the only place `journal_mode = WAL` can be set before the first
query.

`create: false` **does not currently stop file creation**: `new Database(path,
{ create: false })` still creates a missing file on Bun 1.3.14. Use `readOnly` if
the file must already exist.

`strict: true` is this package's default and it is deliberately not the driver's.
Strict mode turns an unsupported binding into a `TypeError` instead of a silent
`NULL`. It is also why `SqliteOptions` opens the `bun:sqlite` handle itself instead
of letting `drizzle('./dev.db')` do it: drizzle's own path forwards only
`readonly`/`create`/`readwrite` and hands back a **non-strict** handle.

## Synchronous mode: `SyncSqliteOptions`

`bun:sqlite` is synchronous underneath, and `@dunx/http` has a dispatch path that
allocates no promise when a handler returns a plain value. So a request can in
principle go parse, query, respond without ever yielding. Reads already could,
because drizzle's bun-sqlite builders have `.all()`, `.get()` and `.run()`. What
stopped a **write** was `transaction()`, which returns a promise, so any route that
wrote anything went back to `async`.

`SyncSqliteOptions` closes that. Every init field is `SqliteOptions`'s. Choosing it
changes exactly two things: the token becomes `SyncDatabase`, and
`transactionSync(db, fn)` becomes reachable.

```ts
DbModule.forRoot(new SyncSqliteOptions({ schema, filename: './dev.db' }));
```

```ts
import { SyncDatabase, transactionSync } from '@dunx/infra/db';
import { desc, sql } from 'drizzle-orm';
import * as schema from './schema.js';
import { widgets, type Widget } from './schema.js';

export class SyncWidgets implements OnInit {
  constructor(private readonly db: SyncDatabase<typeof schema>) {}

  /** Returns void, not Promise<void>. There is nothing to wait for. */
  onInit(): void {
    this.db.run(sql`CREATE TABLE IF NOT EXISTS widgets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      weight INTEGER NOT NULL
    )`);
  }

  add(name: string, weight: number): Widget {
    return this.db.insert(widgets).values({ name, weight }).returning().get();
  }

  list(): readonly Widget[] {
    return this.db.select().from(widgets).orderBy(desc(widgets.id)).all();
  }
}
```

### Why it is a sibling class and not a flag

The mode decides the handle type, and the handle type is what `DbModule.forRoot`
infers the injection token from. A flag would leave that inference with a union to
guess at.

`SyncDatabase` is an empty subclass of `BunSQLiteDatabase` with **one declared
property**, `synchronous: true`. That property is the whole mechanism. TypeScript
is structural, so an empty subclass would be mutually assignable to its base and
would gate nothing. `SyncSqliteConnection` defines the property on the handle
drizzle built, so the type is true rather than claimed.

The relationship is **one-way**. A `SyncDatabase` _is_ a `BunSQLiteDatabase`, so
`transaction()`, `runSeeds` and repositories written before the mode existed all
still take one. Synchronous mode is a superset, not a fork. What does not work is
the reverse: a service annotating `SyncDatabase` under `SqliteOptions` fails to
resolve at boot, because nothing bound that token.

### How to choose, and what it is actually worth

Measured through a real `Bun.serve` with `bun run db-modes` in `tools/bench`,
interleaved round-robin, `requestLogging: false` so every route stays on the
direct dispatch path. AMD Ryzen 9 5950X, Bun 1.3.14, oha 1.15.0, 64 connections,
11 rounds of 5 s, medians:

| unit          | req/s  |    σ | p50 ms | p99 ms |
| ------------- | ------ | ---: | ------ | ------ |
| `read:async`  | 17,625 | 1368 | 3.473  | 7.002  |
| `read:sync`   | 18,399 | 1411 | 3.268  | 6.729  |
| `write:async` | 7,942  |  370 | 7.435  | 15.580 |
| `write:sync`  | 8,283  |  410 | 7.104  | 15.140 |

**Synchronous mode is about 4-6% more req/s and 0.2-0.3 ms off p50**, reproduced
across two independent runs (read +5.7% then +4.4%; write +4.2% then +4.3%).

The rest of it, plainly: σ on the read rows is about 8% of the median, so a single
round proves nothing and the per-round ranges overlap. The effect is real, in that
it is consistent in direction across 18 rounds and both scenarios, but **it sits
at the edge of this box's noise floor, not comfortably above it**. At roughly
57 µs of service time per request, the saving is about 3 µs: one async frame, one
promise from drizzle's thenable builder, one promise adoption in the dispatch
path.

And the framing that motivated the work, "one API call could be 5-10 ms instead of
30-50 ms", is **right about SQLite and wrong about this feature**. That difference
is an embedded database versus one over a network, and an app gets it from
`SqliteOptions` just as much as from `SyncSqliteOptions`.

So:

- **Pick `SqliteOptions`** if the app might move to Postgres later. Every call is
  already awaited, so the move costs no signature change.
- **Pick `SyncSqliteOptions`** if SQLite is the decision for good and you want a
  request path with no promise in it at all. Sync mode is SQLite forever.

There is deliberately **no `SyncSqlOptions`, and there will not be one.**
`Bun.SQL` talks to a server over a socket, and no amount of API design makes a
Postgres query return a row instead of a promise. The asymmetry is structural:
`SqlOptions` simply has no sync sibling, and `transactionSync` does not accept a
`BunSQLDatabase`.

## Querying

drizzle's builder, unchanged. On `bun:sqlite` it is **synchronous**, so a statement
ends in `.run()`, `.all()` or `.get()`. On Postgres, awaiting the builder executes
it.

```ts
db.insert(users).values({ email }).run();
const rows = db.select().from(users).orderBy(users.id).limit(10).all();
const one = db.select().from(users).where(eq(users.id, id)).get();
```

`.get()` returns **`undefined`** when there is no row, which is drizzle's choice
and worth knowing if you are coming from a wrapper that returned `null`.

Repository methods are still worth declaring `async` on `bun:sqlite` if you are on
`SqliteOptions`: callers await them anyway, and moving that table to Postgres later
then costs no signature change.

Raw SQL is where the two adapters share nothing at all. bun-sqlite has
`run`/`all`/`get`/`values` and no `execute`; bun-sql has `execute` and none of the
others:

```ts
import { sql } from 'drizzle-orm';

db.run(sql`PRAGMA foreign_keys = ON`); // bun-sqlite
const counted = db.all<{ n: number }>(sql`SELECT count(*) AS n FROM users`);

await pg.execute(sql`CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY)`);
```

### Two sharp edges in raw SQL

**`prepare()` compiles one statement and silently drops the rest.** A
multi-statement string, say four `CREATE TABLE`s separated by semicolons, creates
the first table only, with no error. That reaches through drizzle, because
``db.run(sql`...`)`` goes via `prepare`. A DDL block has to be one statement per
call; `db.exec()` on the raw handle is the one that takes several.

**A `Date` is not normalised for you, and on a non-strict handle the failure is
silent.** Measured on Bun 1.3.14 with drizzle-orm 0.45.2:

```ts
db.run(sql`INSERT INTO audit (at) VALUES (${new Date()})`);
// strict: true  (this package's default) -> DrizzleError, cause: Missing parameter "1"
// strict: false                          -> no error at all, and the column holds NULL
```

Two ways to write a timestamp, both verified. Pick one per column, because they
store different things:

```ts
// 1. A TEXT column and a raw template: convert it yourself.
db.run(sql`INSERT INTO logins (at) VALUES (${new Date().toISOString()})`);

// 2. A column that declares its mode, and the builder. drizzle maps both ways.
export const audit = sqliteTable('audit', {
  at: integer('at', { mode: 'timestamp' }).notNull(), // epoch seconds
});
db.insert(audit).values({ at: new Date() }).run();
```

The mapping belongs to the **column**, so it applies to the builder and never to a
`sql` template. Postgres is the exception: it parses a `timestamptz` from the
string and takes a native `Date` binding as well.

## Transactions

`transaction(db, fn)` is a standalone function rather than a method, because on
one of the two backends it **replaces** drizzle's own.

```ts
import { transaction } from '@dunx/infra/db';

const id = await transaction(db, async (tx) => {
  const row = tx.insert(users).values({ email }).returning().get();
  await Bun.sleep(1); // still inside the transaction
  tx.insert(audit).values({ userId: row.id }).run();
  return row.id;
});
```

Commit on return, roll back on throw, and the throw propagates. Nesting takes a
savepoint, so an inner failure unwinds only the inner work.

### Why it is not `db.transaction()` on `bun:sqlite`

Because drizzle's is synchronous there. `drizzle-orm/bun-sqlite`'s session hands
the callback straight to `bun:sqlite`'s own wrapper:

```js
const nativeTx = this.client.transaction(() => {
  result = transaction(tx);
});
nativeTx[config.behavior ?? 'deferred']();
```

That wrapper commits as soon as the callback **returns its promise**. So
`client.inTransaction` is already `false` before the first `await` resumes, every
statement after it runs in autocommit, and a later throw rolls back nothing.
Measured on Bun 1.3.14: insert, `await Bun.sleep(1)`, throw, catch, and the row is
still there.

drizzle inherits the behaviour rather than fixing it, which is why `transaction()`
issues `BEGIN`/`COMMIT`/`ROLLBACK` itself. There is only one connection, so two
overlapping top-level transactions would issue a nested `BEGIN`; they queue
instead. A nested call is already inside the holder's turn and takes a savepoint,
so it must not queue behind itself.

On **Postgres** the same function delegates to drizzle's `db.transaction()`, which
is genuinely async, because `Bun.SQL`'s `begin()` reserves a connection for the
duration. The handle the callback receives there is drizzle's `PgTransaction`
(exported as `SqlTransaction<TSchema>`), not the database, because the pooled outer
handle would take a different connection and sit outside the transaction. Nesting
on Postgres is therefore `tx.transaction(...)`, drizzle's own savepoint.

### `transactionSync(db, fn)`, where `db.transaction()` **is** right

Everything above is downstream of the callback being asynchronous. Take the
promise away and `bun:sqlite`'s wrapper is exactly correct, so `transactionSync`
delegates to drizzle's own `db.transaction()` rather than issuing statements
itself: one native transaction, no `BEGIN` strings, no queue, no promise.

```ts
const total = transactionSync(this.db, (tx) => {
  tx.insert(widgets).values({ name: first, weight: 1 }).run();
  if (fail) throw new Error('rolling back on purpose');
  tx.insert(widgets).values({ name: second, weight: 2 }).run();
  return tx.select().from(widgets).all().length;
});
```

It returns the value, not a promise, and throws where `transaction()` rejects, so
recovery is `try`/`catch`.

The callback is held to being synchronous **at compile time**. Its return type is
constrained to a non-thenable, so an `async` callback, or one returning
`Promise.resolve(...)`, is a type error naming the constraint rather than a
rollback that silently does nothing. Verified against Bun 1.3.14: with a
synchronous callback the row is gone after a throw; with an async one it is not.

One consequence of that constraint worth knowing: `NotThenable`'s object branch is
a weak type, so TypeScript rejects an object or array sharing no property with
`{ then?: undefined }`. Returning a scalar, as above, is what it currently
accepts.

The two compose. A `transactionSync` opened while an async `transaction()` is
suspended across an `await` takes a **savepoint** rather than failing, because
`bun:sqlite` branches on `Database.inTransaction`, which the outer `BEGIN` already
set.

## Migrations

Schema migrations are **drizzle-kit's**, and dunx does not wrap them.
`drizzle-kit generate` writes the SQL, owns its own journal, and owns the snapshot
folder. Apply them with drizzle's own migrator:

- `drizzle-orm/bun-sqlite/migrator` for `bun:sqlite`, which is synchronous
- `drizzle-orm/bun-sql/migrator` for Postgres, which is async

Wrapping any of that would produce a worse version of something drizzle already
ships, and a second journal that could disagree with the first.

## Seeding

What drizzle-kit has no concept of is **data**, which is what `runSeeds` is for,
and why its journal table is separate from drizzle's.

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

| Option    | Default                          | Notes                                 |
| --------- | -------------------------------- | ------------------------------------- |
| `dir`     | required                         | Directory holding the numbered files  |
| `env`     | `NODE_ENV`, then `'development'` | What `when` is handed                 |
| `table`   | `'dunx_seeds'`                   | The journal table                     |
| `pattern` | `'*.seeder.{ts,js}'`             | Bun runs TypeScript; a build emits JS |

Rules worth knowing:

- **Order is the numeric prefix**, not the filename, so `0010_x` runs after
  `0009_x`. A file without a prefix is an error, and so are two files sharing a
  number. The whole value of a journal is that the order is identical everywhere,
  and a tie would be settled by whatever order `Bun.Glob` happened to scan in.
- **One transaction per seed**, covering the seed **and** its journal row. A seed
  that throws leaves neither the data nor the record, so it is retried on the next
  boot instead of being half-applied and marked done. On `bun:sqlite` that
  transaction is this package's, for the reason above.
- **A `when(env)` refusal is not journaled.** It lands in `skipped` and writes no
  row, so the same file still runs the first time it reaches an environment it
  does belong in.
- The journal table is created `IF NOT EXISTS` on every call, so it is safe on
  every boot. `applied_at` is `TEXT` on SQLite and `TIMESTAMPTZ` on Postgres,
  written as an ISO 8601 **string** either way, because of the `Date` refusal
  above.

The handle a seed receives is the transaction's, which on `bun:sqlite` **is** the
database (one connection) and on Postgres is a `PgTransaction`.
`SeedHandle<TSchema>` is the union; a seed file annotates the one it was written
for, since a body that names tables is dialect-specific anyway.

## MySQL

There is no MySQL backend in `@dunx/infra/db`, and that is a documented gap with a
worked route around it.

drizzle 0.45.2 has **no Bun-native MySQL driver.** Its only Bun entrypoints are
`bun-sql`, which is Postgres by construction, and `bun-sqlite`. Its MySQL drivers
are `mysql2` and `mysql-proxy`, and `mysql2` is a JavaScript reimplementation of a
wire protocol Bun already speaks, so it is banned.

`drizzle-orm/mysql-proxy` is the way through: drizzle's MySQL dialect with the
transport left as a callback, and `Bun.SQL` supplying the transport. drizzle owns
the SQL generation and the schema, Bun owns every byte of I/O, and nothing pulls in
`mysql2`.

A working `DbOptions` for it is in **`examples/databases/src/mysql/driver.ts`**,
about forty lines, needing **no change to the package**, which is the strongest
available evidence that `DbOptions.open()` is the right seam. Verified end to end
against MySQL 8 on Bun 1.3.14: inserts, selects, `where`, ordering, updates,
deletes, aggregates, `$returningId()` single and multi-row, inner and left joins,
`placeholder()` prepared statements, and the `mysql-proxy` migrator.

Four details the adapter has to get right, each measured:

- **`.values()` is mandatory for `method === 'all'`.** drizzle's `mapResultRow`
  indexes rows **positionally**, and `Bun.SQL`'s default object rows lose columns
  on a join: selecting `users.id, users.name, posts.id, posts.name` returns two
  keys, not four, because the later names overwrite the earlier ones. A manual
  object-to-array conversion would be silently wrong.
- **`method === 'execute'` covers SELECTs too**, whenever the query carries no
  fields. Return the rows when the result array is non-empty, or
  ``db.execute(sql`...`)`` silently yields nothing.
- **`insertId` and `affectedRows` go in `rows[0]`**, not at the top level, despite
  `RemoteCallback`'s declared type. `mysql-proxy/session.js` reads
  `data[0].insertId`, and Bun's own property is `lastInsertRowid`.
- **Name the `adapter`.** In the **options-object** form on Bun 1.3.14,
  `POSTGRES_URL`, `PGURL` or `TLS_POSTGRES_DATABASE_URL` in the environment
  silently overrides an explicitly passed `url` and forces `adapter: 'postgres'`,
  so a MySQL URL is dialled as Postgres and fails with a bare
  `Connection closed`. `new Bun.SQL(urlString)` and `new Bun.SQL(new URL(url))`
  are unaffected, and so is naming the adapter.

`mysql-proxy` also refuses `db.transaction()` outright, because a callback
transport has no way to pin its statements to one connection. `Bun.SQL`'s
`begin()` does have a way, so the example opens the transaction on the client and
builds a second drizzle handle over the reserved socket. That is the one functional
gap against drizzle's `mysql2` driver, and it costs an extra handle rather than
costing correctness.

One more, if you write a CLI or a seeder against MySQL: an in-flight `Bun.SQL`
query on the **MySQL** adapter does not hold the event loop open. A script whose
only pending work is such a query exits with code 0, mid-query, with no error.
`Bun.serve` keeps a reference so a server never sees it; hold a `setInterval` for
the duration of the work in a one-shot script.

## The raw handle and shutdown

`DbConnection` holds `backend`, `dialect`, `db` (the drizzle handle), `raw` (the
`bun:sqlite` `Database` or the `Bun.SQL` client), and an idempotent `close()`.

`raw` is typed `unknown`, because the base cannot promise either backend's handle.
Narrow with `instanceof SqliteConnection` or `instanceof SqlConnection`, which
restores the concrete type.

`onShutdown()` is concrete rather than abstract: the hook and the explicit call are
one operation. `@dunx/core` shuts down in reverse construction order, and every
repository depends on the drizzle handle which depends on the connection, so
everything holding it has already drained by the time it closes.

## No entity decorators

They were tried on TypeScript 7.0.2, both routes, and both fail with `TS2339:
Property 'table' does not exist`:

```ts
@Entity('users')
class UserA {}
UserA.table; // decorator defineProperty'd a static
@Entity('users')
class UserB {}
UserB.table; // decorator's return type is C & { table }
```

TC39 decorators are **type-transparent** in TypeScript: the decorator's return type
does not become the declaration's type. And drizzle's whole value is the table
object's _type_ carrying column types into every query, so a decorator could build
a working table at runtime while every query degraded to `unknown`. Recovering the
types would mean hand-writing a mapped type mirroring drizzle's `BuildColumns`, a
second source of truth that drifts from the first.

## Related

- [Configuration](./11-configuration.md) for `forRootAsync` and `AppConfigService`
- [Authentication](./15-authentication.md), where `drizzleDatabase(connection)`
  hands better-auth the connection this module already opened
- [Providers](./03-providers.md) for factory providers and resolution order
