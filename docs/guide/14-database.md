# Database

`@dunx/infra/db` is **drizzle**, wired into the container. What it adds is what
a drizzle handle does not have on its own: a lifecycle, module wiring, an
async-safe transaction, and data seeding. It adds no query abstraction, no
entity decorators, and no repository base class. drizzle is the interface.

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

Inject drizzle's own class, such as `BunSQLiteDatabase<typeof schema>`. There is
no dunx wrapper. `@dunx/transform` resolves the class and ignores the type
argument, which only gives you the schema types.

`schema` is required because it supplies the type argument in
`BunSQLiteDatabase<typeof schema>` at every injection site. Pass `{}` if you
only run `sql` templates.

## What `DbModule` binds

| Token                                                   | What it is                                                 |
| ------------------------------------------------------- | ---------------------------------------------------------- |
| `DbOptions`                                             | The resolved configuration, so anything can read `dialect` |
| `DbConnection`                                          | The lifecycle and the raw driver handle                    |
| `BunSQLiteDatabase` / `BunSQLDatabase` / `SyncDatabase` | The drizzle handle a repository injects                    |

The connection closes last on shutdown, after every repository has finished.
dunx shuts down in reverse construction order, and the drizzle handle is built
from `DbConnection`, so the connection is always constructed first.

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

Unlike `forRoot`, the token is the first argument. The drizzle class depends on
the options, and the options only exist after the factory runs. That is too late
to register a provider, so you name the token up front.

See [Configuration](./12-configuration.md) for why the parameter is
`AppConfigService` rather than `ConfigService<AppConfig>`.

## Several data sources

One application may hold more than one database: a reporting replica beside the
primary, an audit database, or a database per tenant. `DbModule` covers the two
cases separately, because they are different problems.

| Registration                     | When the set of databases is known |
| -------------------------------- | ---------------------------------- |
| `forRoot(options, { name })`     | At configuration time              |
| `forDataSources({ create }, As)` | Only at runtime, from a key        |

### Named data sources

Give each extra database a `name`. An unnamed registration binds `DbOptions`,
`DbConnection` and drizzle's class. A named registration binds its own copy of
each under that name instead:

```ts
@Module({
  imports: [
    DbModule.forRoot(new SqlOptions({ schema, url: primaryUrl })),
    DbModule.forRoot(new SqlOptions({ schema, url: reportingUrl }), {
      name: 'reporting',
    }),
  ],
})
export class DataModule {}
```

Four functions return the tokens of a named registration. Each returns the same
token for the same name, so the module and its consumers always agree:

| Factory              | Resolves to                              |
| -------------------- | ---------------------------------------- |
| `dbHandle(name)`     | The drizzle handle a repository reads    |
| `dbConnection(name)` | The lifecycle and the raw driver         |
| `dbOptions(name)`    | The resolved configuration               |
| `dbMetrics(name)`    | Its `QueryMetrics`, when `metrics` is on |

A `Token` is no constructor type, so it cannot be a constructor parameter.
Declare it once with the handle type and reach it with `inject()`:

```ts
export const reportingDb = dbHandle<BunSQLDatabase<typeof schema>>('reporting');

export class Reports {
  readonly db = inject(reportingDb);

  totals() {
    return this.db.select().from(rollups).all();
  }
}
```

The type argument on `dbHandle` gives your queries drizzle's types. A lookup
such as `dataSources.get('reporting')` would have to return a union across
schemas and would lose them, so named data sources have no such method.

`forRootAsync` takes the same `name`. Its first argument then fixes what
`dbHandle(name)` resolves to rather than being the binding itself:

```ts
DbModule.forRootAsync(
  BunSQLDatabase<typeof schema>,
  {
    useFactory: (config: AppConfigService) =>
      new SqlOptions({ schema, url: config.get('reporting').url }),
    inject: [AppConfigService],
  },
  { name: 'reporting', metrics: true },
);
```

### Data sources resolved at runtime

A database per tenant cannot be registered ahead of time: the keys are not known
when the module is configured, and a binding per tenant would not scale anyway.
`forDataSources` binds a pool that opens a data source the first time a key asks
for one and reuses it after.

`as` is a subclass. The subclass carries the handle type to the injection site:
`DataSources` is generic and a token holds no type argument.

```ts
export class TenantSources extends DataSources<BunSQLDatabase<typeof schema>> {}

DbModule.forDataSources(
  {
    create: (tenant) => new SqlOptions({ schema, url: urlFor(tenant) }),
    max: 32,
    idleMs: 300_000,
  },
  TenantSources,
);
```

The key is an argument at every call. The pool holds no current data source, so
two requests in flight for two tenants cannot read each other's rows:

```ts
export class Tickets {
  constructor(private readonly sources: TenantSources) {}

  async list(tenant: string) {
    return this.sources.use(tenant, (db) => db.select().from(tickets).all());
  }
}
```

If the tenant comes from the request rather than from a path parameter, read it
from `RequestContext` at the call site. That keeps resolution inside the
`AsyncLocalStorage` scope the request already runs in.

#### What the pool holds, and when it lets go

| Method            | Does                                                      |
| ----------------- | --------------------------------------------------------- |
| `use(key, work)`  | Runs `work` with the handle, holding the data source open |
| `get(key)`        | The drizzle handle, with no lease                         |
| `connection(key)` | The `DbConnection`, for a ping or the raw driver          |
| `evict(key)`      | Closes one and forgets it, borrowed or otherwise          |
| `prune()`         | Closes every unborrowed data source past `idleMs`         |
| `keys()`, `size`  | What is live now                                          |

`max` bounds how many data sources are live at once, so an unbounded key space
cannot exhaust the database's connection limit. Reaching it
closes the least recently used data source that nothing is borrowing. If every
one is borrowed, the resolution fails with a `DatabaseError` naming the bound
instead of opening one more connection.

`use` is the shape to prefer. Eviction skips a borrowed data source, so a long
query cannot have its connection closed underneath it. `get` has no such
protection, and a handle kept across an await may outlive its data source.

`idleMs` closes a data source nobody has asked for. The sweep runs every
`sweepMs`, which defaults to `idleMs`, so a data source lives for at most the two
added together after its last use. `idleMs: 0` keeps every one until shutdown.

Eviction frees the slot immediately and closes the old data source in the
background, so opening one tenant's data source never waits for another tenant's
to close. `closeTimeoutMs` limits both an open and a close. `close()` still
waits for every pending close before it resolves.

A `create` that throws is not cached. The entry is dropped, so the next
resolution calls `create` again rather than serving the failure forever.

Set `{ metrics: true }` and every data source the pool opens is timed into one
shared `QueryMetrics`, bound under `dbMetrics(name)`, where `name` defaults to
the class name. Two pools whose classes share a name need one each. A set of
histograms per tenant would grow without a bound; the pool's does not.

The pool is built before anything that injects it, so at shutdown every consumer
finishes first and then the pool closes every live data source.
`forDataSourcesAsync` works the same way, with the init returned by a factory
that can await and inject.

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
before any I/O. A non-Postgres URL throws with a message saying why:

> `drizzle-orm/bun-sql` builds a `PgDialect` **unconditionally**. Read from
> drizzle-orm 0.45.2's `bun-sql/driver.js`, there is no branch on
> `client.options.adapter` anywhere in the module.

drizzle does not fail when given a `sqlite://` client. It sends Postgres syntax
(`$1` placeholders, Postgres identifier quoting) to SQLite, simple queries pass,
and the rest break later. So `SqlOptions` refuses the URL.

The handshake is awaited inside `open()` rather than deferred to the first query.

### `SqliteOptions`

| Field          | Default      | Notes                                                         |
| -------------- | ------------ | ------------------------------------------------------------- |
| `schema`       | required     | The type argument that reaches every injection site           |
| `filename`     | `':memory:'` | A path, or a `sqlite:`/`file:` URL, whose scheme is stripped  |
| `readOnly`     | `false`      | Opens `SQLITE_OPEN_READONLY`, suppresses `create`             |
| `create`       | `true`       | `false` throws on a missing file on Bun 1.4; see below        |
| `strict`       | `true`       | **Not the driver's default.** See below                       |
| `safeIntegers` | `false`      | Return integers as `bigint` rather than truncating to 53 bits |
| `pragmas`      | `[]`         | Run once after opening, each prefixed with `PRAGMA`           |
| `casing`       | drizzle's    | `'snake_case'` or `'camelCase'`, forwarded to `drizzle()`     |
| `logger`       | drizzle's    | `true`, or anything with `logQuery`, forwarded to `drizzle()` |

`pragmas` is the only place `journal_mode = WAL` can be set before the first
query.

`create: false` behaves differently across Bun versions. On 1.4 it throws
`bad parameter or other API misuse` when the file is missing - the behaviour
the option is for. On 1.3.14 it created the file anyway. `readOnly` refuses a
missing file on both, with `unable to open database file`, so it is the
portable way to require an existing database.

`strict: true` is this package's default and the driver's is not. Strict mode
turns an unsupported binding into a `TypeError` instead of a silent `NULL`. It is also why `SqliteOptions` opens the `bun:sqlite` handle itself instead
of letting `drizzle('./dev.db')` do it: drizzle's own path forwards only
`readonly`/`create`/`readwrite` and hands back a **non-strict** handle.

### drizzle's own options: `casing` and `logger`

Both backends' init types extend `DrizzleInit`. Its two fields, `casing` and
`logger`, are passed to `drizzle()` unchanged, so you can set them without
opening the handle yourself:

```ts
DbModule.forRoot(
  new SqliteOptions({
    schema,
    filename: './dev.db',
    casing: 'snake_case',
    logger: { logQuery: (query, params) => logger.debug(query, { params }) },
  }),
);
```

`casing: 'snake_case'` lets a column be declared as `text()` with no name and
resolve to `first_name`. It has to agree with `drizzle.config.ts`, because
drizzle-kit generates migrations from the config while the handle queries with
this - if they disagree, the migration writes one column name and the query reads
another.

`logger` takes `true` for drizzle's console output, or any object with a
`logQuery(query, params)` method. Send it to the injected `Logger` at `debug` to
see what a slow endpoint queries. It is set per connection, so a
`DB_LOG_QUERIES` env flag is `logger: config.DB_LOG_QUERIES` inside a
`forRootAsync` factory.

`SqlOptions` removes both before building the `Bun.SQL` options, as it does with
`schema` and `url`. The driver does not know what `casing` means.

## Synchronous mode: `SyncSqliteOptions`

`bun:sqlite` is synchronous, and `@dunx/http` allocates no promise when a
handler returns a plain value. A request can therefore parse, query and respond
without yielding.

Reads already work this way, with drizzle's `.all()`, `.get()` and `.run()`.
Writes did not: `transaction()` returns a promise, so any route that wrote had
to be `async`.

`SyncSqliteOptions` fixes that. It takes the same fields as `SqliteOptions` and
changes two things: the token becomes `SyncDatabase`, and you can call
`transactionSync(db, fn)`.

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
still take one. Synchronous mode is a superset rather than a fork. The reverse
fails: a service annotating `SyncDatabase` under `SqliteOptions` does not resolve
at boot, nothing having bound that token.

### How to choose, and what it is actually worth

Synchronous mode is only slightly faster. Through a real `Bun.serve` it gives
**about 4-6% more req/s and 0.2-0.3 ms lower p50**, close to the benchmark
machine's noise: about 3 µs saved on roughly 57 µs of service time. SQLite's big
speed advantage (5-10 ms against 30-50 ms) comes from being embedded rather than
networked, and both `SqliteOptions` and `SyncSqliteOptions` get it.

The table and method are in [the database layer](../architecture/database.md).

So:

- **Pick `SqliteOptions`** if the app might move to Postgres later. Every call is
  already awaited, so the move costs no signature change.
- **Pick `SyncSqliteOptions`** if SQLite is the decision for good and you want a
  request path with no promise in it at all. Sync mode is SQLite forever.

Postgres has no synchronous mode. `Bun.SQL` talks to the server over a socket,
so every query returns a promise. There is no `SyncSqlOptions`, and
`transactionSync` does not accept a `BunSQLDatabase`.

## Querying

drizzle's builder, unchanged. On `bun:sqlite` it is **synchronous**, so a statement
ends in `.run()`, `.all()` or `.get()`. On Postgres, awaiting the builder executes
it.

```ts
db.insert(users).values({ email }).run();
const rows = db.select().from(users).orderBy(users.id).limit(10).all();
const one = db.select().from(users).where(eq(users.id, id)).get();
```

`.get()` returns **`undefined`** when there is no row. Wrappers that returned
`null` are a common source of confusion here.

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

The column's `mode` does the mapping. The query builder uses it; a `sql`
template does not. On Postgres you can bind a `Date` directly, and Postgres also
parses a `timestamptz` from a string.

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

So on `bun:sqlite`, dunx's `transaction()` sends `BEGIN`, `COMMIT` and
`ROLLBACK` itself. SQLite has one connection, so two top-level transactions
cannot overlap: the second waits for the first to finish. A nested call takes a
savepoint and does not wait.

On **Postgres** the same function delegates to drizzle's `db.transaction()`,
which is genuinely async: `Bun.SQL`'s `begin()` reserves a connection for the
duration.

On Postgres, run every query through `tx`, not the outer `db`. `tx` is
drizzle's `PgTransaction` (exported as `SqlTransaction<TSchema>`). The outer
handle is a pool, so a query on it runs on another connection, outside the
transaction. To nest, call `tx.transaction(...)`, which takes a savepoint.

### `transactionSync(db, fn)`, where `db.transaction()` **is** right

With a synchronous callback, `bun:sqlite`'s own transaction works correctly.
`transactionSync` uses drizzle's `db.transaction()` directly: one native
transaction, with no queue and no promise.

```ts
const total = transactionSync(this.db, (tx) => {
  tx.insert(widgets).values({ name: first, weight: 1 }).run();
  if (fail) throw new Error('rolling back on purpose');
  tx.insert(widgets).values({ name: second, weight: 2 }).run();
  return tx.select().from(widgets).all().length;
});
```

It returns the value rather than a promise, and throws where `transaction()`
rejects, so recovery is `try`/`catch`.

The callback is held to being synchronous **at compile time**. Its return type is
constrained to a non-thenable, so an `async` callback, or one returning
`Promise.resolve(...)`, is a type error naming the constraint rather than a
rollback that silently does nothing. Verified against Bun 1.3.14: with a
synchronous callback the row is gone after a throw; with an async one it is not.

The check also rejects most returned objects and arrays. Return a scalar, such
as a number or string, as above.

You can mix the two. A `transactionSync` inside an async `transaction()` takes a
**savepoint**, because `bun:sqlite` sees that a transaction is already open.

## Migrations

Schema migrations are **drizzle-kit's**, and dunx does not wrap them.
`drizzle-kit generate` writes the SQL, owns its own journal, and owns the snapshot
folder. Apply them with drizzle's own migrator:

- `drizzle-orm/bun-sqlite/migrator` for `bun:sqlite`, which is synchronous
- `drizzle-orm/bun-sql/migrator` for Postgres, which is async

Wrapping any of that would produce a worse version of something drizzle already
ships, and a second journal that could disagree with the first.

## Seeding

drizzle-kit has no concept of **data**. `runSeeds` covers that, with its own
journal table separate from drizzle's.

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

Rules:

- **Order is the numeric prefix** rather than the filename, so `0010_x` runs after
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

There is no MySQL backend in `@dunx/infra/db`, a documented gap with a worked
route around it.

drizzle 0.45.2 has **no Bun-native MySQL driver.** Its only Bun entrypoints are
`bun-sql`, which is Postgres by construction, and `bun-sqlite`. Its MySQL drivers
are `mysql2` and `mysql-proxy`, and `mysql2` is a JavaScript reimplementation of a
wire protocol Bun already speaks, so it is banned.

Use `drizzle-orm/mysql-proxy` instead. It is drizzle's MySQL dialect with the
transport left to a callback, and `Bun.SQL` can be that transport. drizzle
generates the SQL and owns the schema, Bun does all the I/O, and `mysql2` is
never installed.

A working `DbOptions` for it is in **`examples/databases/src/mysql/driver.ts`**:
about forty lines, needing **no change to the package**.

Verified end to end against MySQL 8 on Bun 1.3.14: inserts, selects, `where`,
ordering, updates, deletes, aggregates, `$returningId()` single and multi-row,
inner and left joins, `placeholder()` prepared statements, and the `mysql-proxy`
migrator.

Four details in the adapter matter: rows are read by position with `.values()`,
SELECTs arrive as `execute`, `insertId` is in `rows[0]`, and the `adapter` is
named so a `POSTGRES_URL` in the environment cannot redirect the connection.
`driver.ts` comments each one. Copy the file instead of rewriting it.

`db.transaction()` does not work on `mysql-proxy`, because it cannot keep a
transaction's statements on one connection. The example opens the transaction
with `Bun.SQL`'s `begin()`, which reserves a connection, and builds a second
drizzle handle over it. This is the only feature missing compared with drizzle's
`mysql2` driver.

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

For SQLite there is `asSqlite`, which does that check and returns the `bun:sqlite`
`Database`. Pragmas and triggers are what reach for it:

```ts
import { asSqlite } from '@dunx/infra/db';

asSqlite(connection).exec('pragma foreign_keys = on');
```

`asSqlite` throws with the name of the backend it received. A cast such as
`connection.raw as Database` would instead give you a `Bun.SQL` client typed as
a `Database`. There is no `asSql`: use drizzle's `sql` tag to reach `Bun.SQL`.

`onShutdown()` calls `close()`, so the shutdown hook and an explicit call do the
same thing. `@dunx/core` shuts down in reverse construction order. Every
repository depends on the drizzle handle, which depends on the connection, so
they have all finished before the connection closes.

## Pagination

`@dunx/infra/pagination` does keyset pagination, which stays correct while rows
are being written.

```ts
import { paginate, PAGINATION, type Page } from '@dunx/infra/pagination';

const pageQuery = z.object({
  take: z.coerce.number().int()
    .min(PAGINATION.MIN_TAKE).max(PAGINATION.MAX_TAKE)
    .default(PAGINATION.DEFAULT_TAKE),
  order: z.enum(['asc', 'desc']).default(PAGINATION.DEFAULT_ORDER),
  direction: z.enum(['forward', 'backward']).default(PAGINATION.DEFAULT_DIRECTION),
  cursor: z.string().max(PAGINATION.MAX_CURSOR).optional(),
});
const paged = { query: pageQuery } as const;

@Get('/page', paged)
page({ query }: Input<typeof paged>): Promise<Page<Entry>> {
  return paginate<typeof ledger, Entry>({
    db: this.db,
    table: ledger,
    options: query,
  });
}
```

```json
{
  "data": [{ "id": 9, "memo": "newest" }],
  "meta": {
    "take": 20,
    "hasNextPage": true,
    "hasPreviousPage": false,
    "nextCursor": "eyJzIjoiOSIsImkiOiI5In0",
    "previousCursor": null
  }
}
```

Pass `meta.nextCursor` back as `?cursor=` to read forwards, and
`meta.previousCursor` with `?direction=backward` to go the other way.

In a generic wrapper, pass both type arguments. With only the table,
`paginate` returns the table's full row type, even if you select fewer columns:

```ts
// Infers the table's select type, not TSelect.
return paginate<TTable>({ db, table, options, where });

// Returns Page<TSelect>.
return paginate<TTable, TSelect>({ db, table, options, where });
```

### Why not `OFFSET`

An offset scan re-reads and discards every row before the page, so page 500 costs 500
pages of work. Worse, it is **wrong under writes**: insert a row while someone is
paging and every later page shifts by one, so an item is served twice or skipped. A
cursor names the last row seen, the database seeks straight to it, and a concurrent
insert changes nothing about what has already been read.

The cursor carries the sort value **and** the row id, and the query compares both.
Without the id tie-break, rows sharing a timestamp are silently skipped or
repeated, and a bulk insert produces exactly that.

### The schema you write it against

`paginate` sorts by the first of `updatedAt`, `createdAt`, `id` your table has, or
whatever `orderBy` names. It has to be unique together with the id column, which is
what makes the seek deterministic.

`db` can be either dialect or a transaction handle; anything with drizzle's
`select()` works, on both the synchronous and asynchronous drivers.

### Paginating something that is not a table

`paginate` imports drizzle, which is an optional peer, so
`@dunx/infra/pagination` does not resolve without it. The cursor codec, the
options parser and the envelope need no database and sit at a second subpath:

```ts
import {
  encodeCursor,
  decodeCursor,
  pageOf,
  parsePageOptions,
} from '@dunx/infra/pagination/cursor';
```

A Redis scan, an S3 listing or an upstream API then hands back the same opaque
cursor and the same envelope shape as a table does.

### What it does not do

- **No zod schema is shipped.** `parsePageOptions` is a hand-written validator, since
  route validation targets Standard Schema and shipping a schema would pick the
  library for you. Declare your own, as above, and the parameters land in the OpenAPI
  document.
- **No total count.** `hasNextPage` comes from fetching one row more than asked and
  dropping it, so there is no second `COUNT(*)`.
- **A 400 without a filter.** A bad cursor throws `CursorError`; bad options throw
  `PageOptionsError`. Both extend `AppError` and carry `status = 400`, which is an
  integer rather than a dependency on the web layer, and `@dunx/http`'s default
  mapper turns it into the response. You write no `catch`.

`examples/full` serves it at `GET /api/ledger/page`.

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

TC39 decorators are **type-transparent** in TypeScript: the decorator's return
type does not become the declaration's type.

drizzle gets column types into every query through the table object's _type_. A
decorator could build a working table at runtime, but every query would be typed
`unknown`. Getting the types back would need a hand-written copy of drizzle's
`BuildColumns` mapped type, which would drift from drizzle's own.

## Related

- [Configuration](./12-configuration.md) for `forRootAsync` and `AppConfigService`
- [Authentication](./17-authentication.md), where `drizzleDatabase(connection)`
  hands better-auth the connection this module already opened
- [Providers](./03-providers.md) for factory providers and resolution order
