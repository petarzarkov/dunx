# @dunx/db

Database access for dunx, on `Bun.SQL` and `bun:sqlite`.

No `pg`, no `mysql2`, no `better-sqlite3`, no query builder. The only dependency
is `@dunx/core`.

```ts
import { Module } from '@dunx/core';
import { DbModule, SqliteOptions } from '@dunx/db';

@Module({
  imports: [DbModule.forRoot(new SqliteOptions({ filename: './dev.db' }))],
  providers: [UsersRepository],
})
export class AppModule {}
```

```ts
import { Database } from '@dunx/db';

export class UsersRepository {
  constructor(private readonly db: Database) {}

  findByEmail(email: string) {
    return this.db.sql<User>`SELECT * FROM users WHERE email = ${email}`.get();
  }
}
```

## Two backends, one contract

`Database` is an abstract class, so it is both the injectable token and the
contract. Two implementations satisfy it and nothing else in your code changes
when you swap them.

| | `SqliteOptions` | `SqlOptions` |
| --- | --- | --- |
| Driver | `bun:sqlite` | `Bun.SQL` |
| Dialects | SQLite | Postgres, MySQL, MariaDB, **and SQLite** |
| Connection | one embedded handle | pooled, over a socket |
| Server | none | one has to be running |

### `Bun.SQL` also speaks SQLite — so which do you use?

It does, and this is not documented prominently: `new Bun.SQL('sqlite://:memory:')`
reports `adapter: 'sqlite'` and works. Bun's supported set is exactly
`postgres`, `sqlite`, `mysql`, `mariadb` — that list is quoted from its own
rejection message, and `pg://` is **not** in it.

Prefer `bun:sqlite` (`SqliteOptions`) for SQLite anyway:

- It is synchronous underneath, so there is no pool, no socket and no round trip.
- It exposes the things SQLite users actually want — `serialize()`, `deserialize()`,
  `loadExtension()`, `iterate()`, `PRAGMA` at open time, `safeIntegers`.
- `Bun.SQL`'s SQLite adapter is a thin layer over the same driver, so you pay for
  the abstraction without gaining a capability. It does not even support
  `reserve()` — "This adapter doesn't support connection reservation".

Use `SqlOptions` with a SQLite URL when a single `DATABASE_URL` has to be able to
name either SQLite or Postgres without the app knowing which.

## Querying

Four shapes, all async on both backends:

```ts
// Tagged template — portable. Placeholders are compiled per dialect.
const rows = await db.sql<User>`SELECT * FROM users WHERE age > ${18}`;
const one = await db.sql<User>`SELECT * FROM users WHERE id = ${id}`.get();
const { changes, lastInsertRowid } = await db.sql`DELETE FROM users`.run();

// Raw text with positional parameters — the placeholder syntax is the dialect's.
await db.all<User>('SELECT * FROM users WHERE id = ?', [id]);
await db.get<User>('SELECT * FROM users WHERE id = ?', [id]);
await db.run('UPDATE users SET name = ? WHERE id = ?', [name, id]);

// Several statements, no parameters. For DDL and migrations.
await db.exec('CREATE TABLE a (x INT); CREATE TABLE b (y INT)');
```

`db.sql\`…\`` is lazy — nothing is sent until `all()`, `get()` or `run()`. Awaiting
the query itself is `all()`. `get()` returns `null` rather than `undefined` when
there is no row, and does not edit a `LIMIT` into your SQL.

Every method is a promise even on SQLite, where the driver is synchronous.
Nothing is gained locally; what it buys is that the call site above moves to
Postgres unedited.

### `Date` is normalised for you

`bun:sqlite` rejects a `Date` binding outright — *"Binding expected string,
TypedArray, boolean, number, bigint or null"* — and so does `Bun.SQL`'s SQLite
adapter, because it is the same driver. Both implementations convert a `Date` to
an ISO 8601 string when the dialect is SQLite, and leave it alone everywhere else
so Postgres still gets a native `timestamptz`.

## Transactions

```ts
const id = await db.transaction(async (tx) => {
  const { lastInsertRowid } = await tx.sql`INSERT INTO users (name) VALUES (${name})`.run();
  await tx.sql`INSERT INTO audit (user_id) VALUES (${lastInsertRowid})`.run();
  return lastInsertRowid;
});
```

Commit on return, roll back on throw, and the throw propagates. Use the `tx`
handle for everything inside — on the pooled backend the outer `Database` would
take a different connection and sit outside the transaction.

Nesting opens a savepoint, so an inner failure unwinds only the inner work:

```ts
await db.transaction(async (tx) => {
  await tx.sql`INSERT INTO users (name) VALUES (${'kept'})`.run();
  await tx.transaction(async (sp) => {
    await sp.sql`INSERT INTO users (name) VALUES (${'discarded'})`.run();
    throw new Error('rolled back to the savepoint');
  }).catch(() => {});
});
```

### Why this is not `bun:sqlite`'s own `db.transaction()`

Because that wrapper is synchronous. Handed an `async` callback it commits as soon
as the function **returns its promise**, so anything awaited inside is already
committed and a later rejection rolls back nothing:

```ts
// bun:sqlite directly — the insert survives.
const tx = db.transaction(async () => {
  db.run('INSERT INTO t (name) VALUES (?)', ['ada']);
  await Bun.sleep(1);
  throw new Error('should roll back');
});
await tx().catch(() => {});
db.query('SELECT * FROM t').all().length; // 1
```

`SqliteDatabase` issues `BEGIN`/`COMMIT`/`ROLLBACK` itself instead. Measured on
Bun 1.3.14.

There is also only one connection, so two overlapping top-level transactions
would issue a nested `BEGIN`. They are queued rather than allowed to collide. A
nested call is already inside the holder's turn and takes a savepoint, so it does
not queue behind itself.

## Options are classes

So they are injectable — `constructor(private readonly options: DbOptions)` works,
and reading `options.dialect` is how a repository stays dialect-aware.

```ts
new SqliteOptions({
  filename: './dev.db',          // ':memory:', a path, or a sqlite:/file: URL
  pragmas: ['journal_mode = WAL'], // run once, at open, before the first query
  strict: true,                  // default here, unlike the driver
  safeIntegers: false,
  readOnly: false,
});

new SqlOptions({
  url: process.env.DATABASE_URL!, // scheme decides the dialect
  max: 10,
  idleTimeout: 30,
});
```

`SqlInit` extends `Bun.SQL`'s own option type, so pooling, TLS and auth stay in
sync with whatever Bun supports rather than being restated here.

`SqlOptions` resolves the dialect from the URL **at construction**, so a bad URL
throws before any I/O. It is deliberately stricter than Bun: Bun reads a
schemeless string as a Postgres *host*, so `{ url: './dev.db' }` reports
`adapter: 'postgres'` and then fails much later with a socket error.
`dialectFromUrl` rejects it with a message about the URL.

## `forRoot` and `forRootAsync`

```ts
DbModule.forRoot(new SqliteOptions({ filename: ':memory:' }))

DbModule.forRootAsync({
  useFactory: (config: Config) => new SqlOptions({ url: config.databaseUrl }),
  inject: [Config],
})
```

`forRootAsync` is not a second mechanism — it is `forRoot` with the options
produced by a factory that may await and may inject. It works because dunx
resolves eagerly: every async factory is settled **before any constructor runs**,
so the connection is open and handshaked by the time the first repository is
built. No lazy connect, no `await db.ready()`, no half-initialised client.

Both bind two tokens: `Database`, and `DbOptions` so anything can read the
resolved configuration.

## Shutdown

`Database` implements `OnShutdown`, and `close()` is idempotent. `@dunx/core`
runs shutdown in reverse construction order, so anything that depends on the
connection drains while it is still usable:

```ts
const app = await AppFactory.create(AppModule);
app.enableShutdownHooks();
await app.closed;
```

Using a `Database` after it is closed raises a `DatabaseError` that says so,
rather than a driver crash.

## Repositories

Injecting `Database` directly is fine. `Repository` exists because a subclass
that declares no constructor of its own inherits the base's — and `@dunx/core`
reads constructor dependencies along the prototype chain, so this class gets
`Database` injected while declaring nothing:

```ts
import { Repository } from '@dunx/db';

export class UsersRepository extends Repository {
  findAll() {
    return this.db.all<User>(`SELECT * FROM ${this.table('users')}`);
  }
}
```

### An identifier cannot be a bound parameter

`db.sql\`SELECT * FROM ${table}\`` does not do what it looks like — `${table}`
becomes a *value*, and the statement is a syntax error. A table or column name has
to go into the SQL text, which means it has to be quoted:

```ts
quoteIdentifier(Dialect.MYSQL, 'users'); // `users`
quoteIdentifier(Dialect.POSTGRES, 'users'); // "users"
```

`Repository#table` is that, bound to the connected dialect. Embedded quotes are
doubled, and an empty or NUL-bearing name is rejected.

## The raw handle

Anything backend-specific is still reachable. `raw` is `unknown` on the contract —
narrow to get it typed:

```ts
import { SqlDatabase, SqliteDatabase } from '@dunx/db';

if (db instanceof SqliteDatabase) {
  const snapshot = db.raw.serialize(); // bun:sqlite Database
}
if (db instanceof SqlDatabase) {
  await db.raw.begin('read write', async (tx) => { /* Bun.SQL client */ });
}
```

The `Bun.SQL` client is itself a function — it *is* the tagged template — so
`typeof db.raw === 'function'`.

## Testing

`bun:sqlite` at `:memory:` needs no server, so point `DbModule` at it and test
against a real database:

```ts
const app = await AppFactory.create(
  DbModule.forRoot(new SqliteOptions({ filename: ':memory:' })),
);
```

This package's own `Bun.SQL` suite runs over that driver's SQLite adapter for the
same reason — the whole code path is covered with nothing installed. Set
`DUNX_DB_TEST_URL` to a reachable server to also run the wire-protocol tests;
without it they skip.

## Verified against

Bun 1.3.14. Bun's SQL documentation is incomplete in places, so the behaviour
described above was measured rather than read: the four-adapter list, the
`affectedRows`/`count` split on result metadata, the synchronous-commit behaviour
of `bun:sqlite`'s `transaction()`, the `Date` binding refusal, and the missing
`reserve()` on the SQLite adapter.
