# The database layer

drizzle over `drizzle-orm/bun-sqlite` and `drizzle-orm/bun-sql`. The library owns the abstraction, Bun owns the I/O.

## Database layer (`@dunx/infra/db`)

**drizzle is the database driver rather than an option.** An earlier version of this
package shipped a hand-rolled `Database` abstract class with a `sql` tagged
template, `all`/`get`/`run`/`exec`, a `Repository` base and a `quoteIdentifier`
helper, and two implementations satisfying it. All of that is retired.

This is the second half of the principle - _never invent what a mature library
already solves_ - applied to the one place it was being violated. The
hand-rolled contract was an ORM's front half: it had a query surface, so it
would have grown result mapping, relations, and a migration story, each one a
worse version of something drizzle already ships. The layer now reflects the
rule's own resolution of that tension: **the library owns the abstraction, Bun
owns the I/O**, via `drizzle-orm/bun-sqlite` over `bun:sqlite` and
`drizzle-orm/bun-sql` over `Bun.SQL`.

No `pg`, no `better-sqlite3`. `drizzle-orm` is an optional `peerDependency`, so
the consumer owns the version and an app that never touches a database never
installs it.

What remains is only what a drizzle handle genuinely lacks:

- **A lifecycle.** `DbConnection` is an abstract class - so it is an injection
  token - holding `close()`, `onShutdown()`, `backend`, `dialect`, and the raw
  driver handle. drizzle has none of these; it does not even know whether its
  driver is open.
- **Module wiring.** `DbModule` binds three tokens: `DbOptions`, `DbConnection`,
  and **drizzle's own database class**. That last one is the whole trick: drizzle's
  `BunSQLiteDatabase` and `BunSQLDatabase` are real runtime classes, so a class is
  usable as a token directly. `@dunx/transform` records the bare type name from
  `db: BunSQLiteDatabase<typeof schema>` while ignoring the type argument. One
  erased class is the token; the schema types stay on the annotation. No wrapper
  object, and no `token()` call.
- **An async-safe transaction**, for the bun-sqlite quirk measured above - and a
  synchronous one for when the callback needs no promise at all, below.
- **Data seeding.** `drizzle-kit` owns schema migrations and their journal; it has
  no concept of data. `runSeeds` is numbered files, one transaction per seed
  covering the seed and its journal row, and a separate `dunx_seeds` table so the
  two journals never contend.

**`casing` and `logger` are drizzle's and are forwarded rather than restated.** Both
backends forwarded only `schema` to `drizzle()`, which put two of drizzle's four
config keys out of reach of anything constructed inside the container:
`casing: 'snake_case'` is the standard drizzle idiom, and the query `logger` is
how a slow endpoint gets diagnosed. The port of `nestjs-template` worked around
it by spelling out every column name and dropping `casing` from
`drizzle.config.ts`, so drizzle-kit and the runtime handle would agree. It also
dropped a `DB_LOG_QUERIES` env var as unimplementable.

Both init types now extend `DrizzleInit`, whose two fields are spread into
`drizzle()` verbatim - the type is drizzle's `Casing` and drizzle's `Logger`,
so this package holds no opinion about either and cannot fall behind them.
`SqlOptions` destructures them out before building the `Bun.SQL` options,
exactly as it does `schema` and `url`.

Two costs are accepted rather than papered over. `DbModule.forRootAsync` has to
take the token as its first argument, because which drizzle class the token is,
only becomes knowable after the options factory has run - too late to register a
provider under it. Because schema modules are dialect-specific (`sqliteTable` vs
`pgTable`), the two backends are also a build-time choice: "one `DATABASE_URL`
naming either" is no longer a supported shape, and the old contract only ever
supported it by hiding the differences.

Entity decorators were the alternative considered for the schema and were
**measured and rejected** - see **Verified constraints**, "A decorator cannot
publish a type back onto the class it decorates". drizzle's native object schema is
the supported path.

### Synchronous SQLite mode

`bun:sqlite` is synchronous underneath, and `@dunx/http` has a dispatch path
that allocates no promise when a handler returns a plain value. So a request
can in principle go parse → query → respond without yielding. Reads already
could: drizzle's bun-sqlite builders have `.all()`/`.get()`/`.run()`. What
stopped a _write_ was `transaction()`, which returns a promise, so any route
that wrote anything went back to `async`.

`SyncSqliteOptions` closes that. The mode is a **sibling options class rather than a
flag**, because the mode decides the handle type and the handle type is what
`DbModule.forRoot` infers the injection token from; a flag would leave that
inference with a union to guess at. Choosing it changes exactly two things: the
token becomes `SyncDatabase`, and `transactionSync(db, fn)` becomes reachable.

**`SyncDatabase` is an empty subclass of drizzle's `BunSQLiteDatabase` with one
declared property, `synchronous: true`.** The property is what stops the two
from being structurally identical. TypeScript is structural, so without it an
empty subclass would be mutually assignable and would gate nothing.
`SyncSqliteConnection` defines the property on the handle drizzle
built, so the type is true rather than claimed; it is non-enumerable, so
nothing that walks the handle sees it.

The relationship stays one-way: a `SyncDatabase` **is** a
`BunSQLiteDatabase`, so `transaction()`, `runSeeds` and repositories written
before the mode existed all still take one. Synchronous mode is a superset, not
a fork.

Two type-level gates, both compile errors:

- A service annotating `SyncDatabase` in an app configured with `SqliteOptions`
  fails to resolve at boot - nothing bound that token.
- `transactionSync`'s callback is constrained to a non-thenable return, so an
  `async` callback does not compile.

That second one is the interesting half, because **it inverts the finding
above.** `transaction()` exists because drizzle's bun-sqlite transaction
commits when the callback returns, so an async callback commits before its
first `await` resumes. Every part of that failure is downstream of the callback
being asynchronous. Remove the promise, and `bun:sqlite`'s own wrapper is
exactly right. So `transactionSync` **delegates to drizzle's
`db.transaction()`** instead of issuing `BEGIN`/`COMMIT` itself: no statement
strings, no serialising queue, no promise.

Verified on Bun 1.3.14 - a synchronous callback that throws leaves no row, an
async one leaves the row, the pair the workaround was built for.
Verified too that the two compose: a `transactionSync` opened while an async
`transaction()` is suspended across an `await` takes a **savepoint** rather
than failing, because `bun:sqlite` branches on `Database.inTransaction`, which
the outer `BEGIN` has already set.

**There is no Postgres counterpart and there will not be one.** `Bun.SQL` is a
socket. The asymmetry is structural rather than documented - `SqlOptions` simply has
no sync sibling, and `transactionSync` does not accept a `BunSQLDatabase` - so the
API cannot pretend the two backends are symmetric.

One deliberate ugliness: `SqliteConnection` gained a second type parameter for the
handle, and assigns it with `as unknown as TDb`. The alternatives were a subclass
redeclaring `db`, which TypeScript 7 rejects as `declare override` and which,
without `declare`, would define the field as `undefined` over the base's
assignment. The other option was a standalone `SyncSqliteConnection` that is not a
`SqliteConnection`, breaking `connection instanceof SqliteConnection` for the
raw-handle escape hatch. One cast in one constructor, immediately made true by the
subclass, was the smaller cost.

#### What it measures, which is less than the pitch

`internal/bench`'s `bun run db-modes` runs the comparison end to end through a
real `Bun.serve`, interleaved round-robin for the reason the validation harness
records. Two scenarios run per mode, with `requestLogging: false` so every route
stays on the direct dispatch path: a single indexed `SELECT`, and a transaction
doing two `UPDATE`s and a read. An earlier version inserted rows instead of
updating them and had to be thrown away, because the table grew under later
rounds, so the write scenario measured its own history (σ was twice the median).

AMD Ryzen 9 5950X, 32 threads, Bun 1.3.14, oha 1.15.0, 64 connections, 11 rounds of
5 s, medians:

| unit          | req/s  |    σ | p50 ms | p99 ms |
| ------------- | ------ | ---: | ------ | ------ |
| `read:async`  | 17,625 | 1368 | 3.473  | 7.002  |
| `read:sync`   | 18,399 | 1411 | 3.268  | 6.729  |
| `write:async` | 7,942  |  370 | 7.435  | 15.580 |
| `write:sync`  | 8,283  |  410 | 7.104  | 15.140 |

**Synchronous mode is ~4-6% more req/s and ~0.2-0.3 ms off p50**, reproduced
across two independent runs (read +5.7% then +4.4%; write +4.2% then +4.3%).
Say the rest of it plainly: σ on the read rows is ~8% of the median, so a
single round proves nothing and the per-round ranges overlap. The effect is
real - it is consistent in direction across 18 rounds and both scenarios - but
it sits at the edge of this box's noise floor rather than comfortably above it.

At ~57 µs of service time per request, the saving is roughly 3 µs: one async
frame, one promise from drizzle's thenable builder, one promise adoption in the
dispatch path.

The framing that motivated the work - "one API call could be 5-10 ms instead of
30-50 ms" - is **right about SQLite and wrong about this feature**. That difference
is an embedded database versus one over a network, and an app gets it from
`SqliteOptions` just as much as from `SyncSqliteOptions`. What sync mode buys on top
is single-digit percent, plus a request path with no promise in it at all, which is
worth having and is not worth overselling.

## Constraint errors carry their own status

A unique violation reaching `@dunx/http` used to answer 500. It is a conflict the
caller can act on, and the information needed to say so is in the driver's error.

`toDatabaseError(error)` classifies one and returns a `ConstraintError` carrying
`status`; anything it does not recognise comes back untouched. The status travels
on `AppError.status`, an integer, so `@dunx/infra` still imports nothing of the
web layer. `CursorError` and `PageOptionsError` already worked this way.

Four kinds are distinguished: the four every supported dialect reports
separately. Unique and foreign key answer 409, not-null and check answer 400. A
foreign key sits with the 409s because its two causes - inserting a child with no
parent, and deleting a parent with children - share one driver code, and only the
first is a bad value from the caller.

The driver's message stays out of the response. `@dunx/http` sends `error.message`
to the caller for a 4xx, and a driver names the table, the column and the index in
its own: `duplicate key value violates unique constraint "users_email_key"` would
put the schema in a response body. `ConstraintError` carries a generic message per
kind and holds the original as `cause`. That original is what gets logged.

**Where it is applied.** `transaction`, `transactionSync` and `runSeeds` classify
on the way out: those are the query paths this package owns. Drizzle owns the
rest. Wrapping `db.insert()` would mean restating drizzle's surface, so a
repository calls `toDatabaseError` in its own `catch` - one line, shown in
`examples/full/src/users/users.repository.ts`.

The codes were provoked out of `bun:sqlite`, Postgres 16 and MySQL 8.0 rather than
read off a reference, and the shapes differ enough to matter: both `Bun.SQL`
backends put their own label in `code` and the server's code in `errno`, reversing
where `pg` and `mysql2` keep it. The table is in
[bun-apis.md](../bun-apis.md).
