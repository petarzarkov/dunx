# @dunx/example-databases

Setting up `@dunx/infra/db` on **SQLite** (asynchronous *and* synchronous),
**Postgres** and **MySQL** - the same three operations against each, so the parts
that differ are the only parts on screen.

```bash
bun install
bun run --filter '@dunx/example-databases' start
# or, reloading on every save:
bun run --filter '@dunx/example-databases' dev
```

With nothing installed that prints two SQLite results and says it is skipping
Postgres and MySQL, and exits 0. There is no HTTP anywhere in this example: it
uses `AppFactory`, not `HttpFactory`, so the database wiring is all there is to
read.

## One app, four configurations

| Entry                        | Backend                                     | Handle injected      |
| ---------------------------- | ------------------------------------------- | -------------------- |
| `SqliteModule.asynchronous()` | `drizzle-orm/bun-sqlite` over `bun:sqlite`  | `BunSQLiteDatabase`  |
| `SqliteModule.synchronous()`  | the same, opened in sync mode               | `SyncDatabase`       |
| `PostgresModule.forUrl()`     | `drizzle-orm/bun-sql` over `Bun.SQL`        | `BunSQLDatabase`     |
| `MysqlModule.forUrl()`        | `drizzle-orm/mysql-proxy` over `Bun.SQL`    | `MySqlRemoteDatabase` |

Four containers rather than one, because the container is flat and each binds its
own `DbConnection` - two backends in one app would be a duplicate token, which
dunx rejects at boot naming both modules. Running one app per database is also
what a real deployment does.

## SQLite, two modes

Both are `bun:sqlite`. What differs is whether the handle is a promise.

```ts
// asynchronous - the default
DbModule.forRoot(new SqliteOptions({ schema, filename }));
constructor(private readonly db: BunSQLiteDatabase<typeof schema>) {}
await db.select().from(widgets);

// synchronous
DbModule.forRoot(new SyncSqliteOptions({ schema, filename }));
constructor(private readonly db: SyncDatabase<typeof schema>) {}
db.select().from(widgets).all();
```

**Pick sync if the app is SQLite for good.** `bun:sqlite` is a function call into
SQLite - there is no socket, nothing to wait for, and no reason for a promise. The
handler never yields, so nothing can interleave between two statements.

**Pick async if Postgres is plausible later.** Every call is already awaited, so
the move is a change to one module and to no repository. Compare
[`sqlite/widgets.service.ts`](./src/sqlite/widgets.service.ts) with
[`postgres/widgets.service.ts`](./src/postgres/widgets.service.ts): the imports
differ by two lines and the bodies are the same.

The mode is not a runtime flag, and cannot be: it decides which class the drizzle
handle is bound under, and `DbModule.forRoot` infers the injection
token from. It is also enforced - a service annotating `SyncDatabase` will not
resolve in an app that bound `BunSQLiteDatabase`.

### Transactions differ, and the difference is the point

| Call                       | Takes                | Returns      | Nesting     |
| -------------------------- | -------------------- | ------------ | ----------- |
| `transaction(db, fn)`      | async or sync `fn`   | `Promise<T>` | savepoint   |
| `transactionSync(db, fn)`  | **sync only**        | `T`          | savepoint   |

`transaction()` on `bun:sqlite` issues `BEGIN`/`COMMIT`/`ROLLBACK` itself rather
than delegating to drizzle, because drizzle delegates to `bun:sqlite`'s wrapper,
which commits as soon as the callback *returns its promise* - so every statement
after the first `await` runs in autocommit and a later throw rolls back nothing.

`transactionSync()` **does** delegate, correctly: the whole failure is
downstream of a callback that returns a promise, and this one cannot. An `async`
callback is a compile error naming the constraint.

One wart: `transactionSync`'s return type is constrained to
"not a promise", and that constraint's object branch is a TypeScript *weak type* -
so returning an object or an array from the callback is rejected even though it is
not thenable. Return a scalar, or use the async `transaction()`.

## Postgres

```ts
DbModule.forRoot(new SqlOptions({ schema, url, max: 4 }));
```

`drizzle-orm/bun-sql` over `Bun.SQL`. No `pg`, no `postgres.js` - Bun owns the
socket, the pool and the wire protocol. `SqlInit` extends `Bun.SQL`'s own option
type rather than restating it, so `max`, `idleTimeout` and `tls` are all accepted.

The dialect is resolved from the URL at construction, so a bad URL throws before
any I/O. The handshake is awaited inside `open()`, and dunx settles every async
factory before it constructs anything - so a repository can never be handed a
client that has not connected.

```bash
docker run -d --rm -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
bun run --filter '@dunx/example-databases' start
```

## MySQL

**There is no Bun-native drizzle driver for MySQL, and this example builds one in
about forty lines.** [`mysql/driver.ts`](./src/mysql/driver.ts) is the whole of it,
and `@dunx/infra` needed no change to accept it - `DbOptions.open()` is where a
backend lives, so adding one is a new class rather than an edit to a dispatch table.

The reasoning: drizzle 0.45.2's only Bun entrypoints are `bun-sql` (Postgres,
it builds a `PgDialect` unconditionally) and `bun-sqlite`. Its MySQL drivers
are `mysql2` and `mysql-proxy`. `mysql2` is a JavaScript reimplementation of a
wire protocol Bun already speaks.

`mysql-proxy` is drizzle's MySQL dialect with the transport left as a callback,
so `Bun.SQL` supplies the transport, drizzle owns the SQL, and nothing pulls in
`mysql2`.

```ts
const db = drizzle(async (query, params, method) => {
  if (method === 'all') return { rows: await client.unsafe(query, params).values() };
  const result = await client.unsafe(query, params);
  if (result.length > 0) return { rows: result };
  return { rows: [{ insertId: Number(result.lastInsertRowid ?? 0),
                    affectedRows: Number(result.affectedRows ?? 0) }] };
}, { schema });
```

Three details in that, all load-bearing and all found by running it:

1. **`.values()` is mandatory** for `'all'`. drizzle's `mapResultRow` indexes rows
   positionally, and `Bun.SQL`'s default object rows *lose columns on a join* -
   selecting `users.id, users.name, posts.id, posts.name` comes back with two keys,
   not four. A manual object-to-array conversion would be silently wrong.
2. **`execute` has two shapes.** drizzle passes `'execute'` whenever the query
   carries no fields, which includes `db.execute(sql\`SELECT …\`)`. Without the
   `result.length > 0` branch those rows are discarded.
3. **`insertId` goes in `rows[0]`** rather than at the top level, despite what
   `RemoteCallback`'s type says - `session.js` reads `data[0].insertId`. Following
   the declared signature breaks `$returningId()`. Bun's own property is
   `lastInsertRowid`.

```bash
docker run -d --rm -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=widgets -p 3306:3306 mysql:8
bun run --filter '@dunx/example-databases' start
```

### Verified, and the caveats

Checked against MySQL 8 on Bun 1.3.14 with drizzle-orm 0.45.2: inserts, selects,
`where`, `orderBy`/`limit`/`offset`, updates, deletes, aggregates,
`$returningId()` for single- and multi-row inserts, inner and left joins, prepared
statements with `placeholder()`, and the `drizzle-orm/mysql-proxy` migrator. Type
decoding is drizzle's, so `boolean` 1 arrives as `true` and `timestamp` as a `Date`.

| Caveat                       | Detail                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------ |
| `db.transaction()` throws    | `mysql-proxy` refuses it. `MysqlConnection.transaction` wraps `Bun.SQL`'s `begin()` instead and builds a drizzle handle over the reserved socket. Commit and rollback both verified. |
| streaming / `iterator()`     | Also refused by `mysql-proxy`.                                                 |
| `insertId` is a JS `number`  | `Number()` narrowing; beyond 2^53 rows it would lose precision.                |
| no `RETURNING`               | MySQL's own limitation. `$returningId()` plus a select is the idiom, and `add()` shows it. |

### Two Bun bugs this example works around

Both measured on Bun 1.3.14, both recorded in [docs/bun-apis.md](../../docs/bun-apis.md).

**`POSTGRES_URL` in the environment overrides an explicitly passed `url`.** In
the options-object form only - `new Bun.SQL({ url: 'mysql://…' })` with
`POSTGRES_URL` set silently becomes `adapter: 'postgres'` and dials the wrong
server, failing with a bare "Connection closed". `PGURL` and
`TLS_POSTGRES_DATABASE_URL` do it too; `DATABASE_URL` and `MYSQL_URL` do not.

Unaffected forms: `new Bun.SQL(urlString)`, `new Bun.SQL(new URL(url))`, and
naming `adapter` explicitly. This example does the last two.

**An in-flight MySQL query does not hold the event loop open.** A script with
nothing else pending exits **silently with code 0** in the middle of a query - no
error, no rejection, no output. A server never notices because `Bun.serve` holds a
reference; a CLI does. [`main.ts`](./src/main.ts) holds one `setInterval` for the
duration for exactly this reason. Postgres and `bun:sqlite` are unaffected.

## Migrations

None of the three run migrations here. Schema changes are
`drizzle-kit generate` plus the dialect's own migrator - which own the SQL, the
journal and the snapshot folder - and a `:memory:` database has nowhere to keep any
of that. Each service creates its table in `onInit` instead, which runs after the
graph is built and before the first caller.

`runSeeds()` from `@dunx/infra/db` is the seeding half, and
[`examples/full`](../full/src/database/seeds) uses it.

## Configuration

| Variable       | Default                                                | Effect                        |
| -------------- | ------------------------------------------------------ | ------------------------------- |
| `SQLITE_FILE`  | `:memory:`                                             | a path makes SQLite persist   |
| `POSTGRES_URL` | `postgres://postgres:postgres@localhost:5432/postgres` | where Postgres is             |
| `MYSQL_URL`    | `mysql://root:root@localhost:3306/mysql`               | where MySQL is                |

## Tests

```bash
bun run --filter '@dunx/example-databases' test
```

SQLite always runs. Postgres and MySQL are probed once and reported as **skipped**
if nothing is listening - a skipped test says so, where a silently passing one
would not.
