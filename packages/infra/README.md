# @dunx/infra

Infrastructure for dunx: databases, Redis/Valkey, file storage and images. Four
areas, one package, zero dependencies beyond `@dunx/core`.

Every backend is a `Bun.*` API — `Bun.SQL`, `bun:sqlite`, `Bun.RedisClient`,
`Bun.file`, `Bun.write`, `Bun.Glob`, `Bun.S3Client`, `Bun.Image`. No `pg`, no
`better-sqlite3`, no `ioredis`, no `@aws-sdk`, no `glob`, no `sharp`.

Import from the barrel or from an area subpath — the subpaths exist so it is
obvious what a file uses, and so tree-shaking is not something you have to reason
about:

```ts
import { Database, SqliteOptions } from '@dunx/infra/db';
import { RedisConnection } from '@dunx/infra/redis';
import { Storage, LocalStorageOptions } from '@dunx/infra/files';
import { Images } from '@dunx/infra/images';

// or, everything, from one place
import { Database, Images, RedisConnection, Storage } from '@dunx/infra';
```

Each area follows the same two conventions. Its contract is an **abstract class**,
so it is both the injectable token and the interface — an `interface` erases and
leaves nothing for `@dunx/compiler` to record as a constructor parameter type. And
its `forRootAsync` is not a second mechanism: dunx resolves eagerly and settles
every async factory before any constructor runs, so it is `forRoot` with a factory
in front of it.

## db — `@dunx/infra/db`

Database access on `Bun.SQL` and `bun:sqlite`. No query builder.

```ts
import { Module } from '@dunx/core';
import { DbModule, SqliteOptions } from '@dunx/infra/db';

@Module({
  imports: [DbModule.forRoot(new SqliteOptions({ filename: './dev.db' }))],
  providers: [UsersRepository],
})
export class AppModule {}
```

```ts
import { Database } from '@dunx/infra/db';

export class UsersRepository {
  constructor(private readonly db: Database) {}

  findByEmail(email: string) {
    return this.db.sql<User>`SELECT * FROM users WHERE email = ${email}`.get();
  }
}
```

### Two backends, one contract

`Database` is an abstract class, so it is both the injectable token and the
contract. Two implementations satisfy it and nothing else in your code changes
when you swap them.

|            | `SqliteOptions`         | `SqlOptions`                                  |
| ---------- | ----------------------- | --------------------------------------------- |
| Driver     | `bun:sqlite`            | `Bun.SQL`                                     |
| Dialects   | SQLite                  | Postgres, MySQL, MariaDB, **and SQLite**      |
| Connection | one embedded handle     | pooled, over a socket                         |
| Server     | none                    | one has to be running                         |

#### `Bun.SQL` also speaks SQLite — so which do you use?

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

### Querying

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

#### `Date` is normalised for you

`bun:sqlite` rejects a `Date` binding outright — _"Binding expected string,
TypedArray, boolean, number, bigint or null"_ — and so does `Bun.SQL`'s SQLite
adapter, because it is the same driver. Both implementations convert a `Date` to
an ISO 8601 string when the dialect is SQLite, and leave it alone everywhere else
so Postgres still gets a native `timestamptz`.

### Transactions

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
  await tx
    .transaction(async (sp) => {
      await sp.sql`INSERT INTO users (name) VALUES (${'discarded'})`.run();
      throw new Error('rolled back to the savepoint');
    })
    .catch(() => {});
});
```

#### Why this is not `bun:sqlite`'s own `db.transaction()`

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

### Options are classes

So they are injectable — `constructor(private readonly options: DbOptions)` works,
and reading `options.dialect` is how a repository stays dialect-aware.

```ts
new SqliteOptions({
  filename: './dev.db',            // ':memory:', a path, or a sqlite:/file: URL
  pragmas: ['journal_mode = WAL'], // run once, at open, before the first query
  strict: true,                    // default here, unlike the driver
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
schemeless string as a Postgres _host_, so `{ url: './dev.db' }` reports
`adapter: 'postgres'` and then fails much later with a socket error.
`dialectFromUrl` rejects it with a message about the URL.

### `forRoot` and `forRootAsync`

```ts
DbModule.forRoot(new SqliteOptions({ filename: ':memory:' }));

DbModule.forRootAsync({
  useFactory: (config: Config) => new SqlOptions({ url: config.databaseUrl }),
  inject: [Config],
});
```

Both bind two tokens: `Database`, and `DbOptions` so anything can read the
resolved configuration. Because factories settle before any constructor runs, the
connection is open and handshaked by the time the first repository is built. No
lazy connect, no `await db.ready()`, no half-initialised client.

### Shutdown

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

### Repositories

Injecting `Database` directly is fine. `Repository` exists because a subclass
that declares no constructor of its own inherits the base's — and `@dunx/core`
reads constructor dependencies along the prototype chain, so this class gets
`Database` injected while declaring nothing:

```ts
import { Repository } from '@dunx/infra/db';

export class UsersRepository extends Repository {
  findAll() {
    return this.db.all<User>(`SELECT * FROM ${this.table('users')}`);
  }
}
```

#### An identifier cannot be a bound parameter

`db.sql\`SELECT * FROM ${table}\`` does not do what it looks like — `${table}`
becomes a _value_, and the statement is a syntax error. A table or column name has
to go into the SQL text, which means it has to be quoted:

```ts
quoteIdentifier(Dialect.MYSQL, 'users'); // `users`
quoteIdentifier(Dialect.POSTGRES, 'users'); // "users"
```

`Repository#table` is that, bound to the connected dialect. Embedded quotes are
doubled, and an empty or NUL-bearing name is rejected.

### The raw handle

Anything backend-specific is still reachable. `raw` is `unknown` on the contract —
narrow to get it typed:

```ts
import { SqlDatabase, SqliteDatabase } from '@dunx/infra/db';

if (db instanceof SqliteDatabase) {
  const snapshot = db.raw.serialize(); // bun:sqlite Database
}
if (db instanceof SqlDatabase) {
  await db.raw.begin('read write', async (tx) => {
    /* Bun.SQL client */
  });
}
```

The `Bun.SQL` client is itself a function — it _is_ the tagged template — so
`typeof db.raw === 'function'`.

### Testing

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

## Verified against

Bun 1.3.14. Bun's documentation is incomplete across all four areas, so the
behaviour described above was measured rather than read: the four `Bun.SQL`
adapters, the `affectedRows`/`count` split on result metadata, the
synchronous-commit behaviour of `bun:sqlite`'s `transaction()`, the `Date`
binding refusal, the missing `reserve()` on the SQLite adapter, the unusable
`psubscribe`, the synchronous throws from `Bun.RedisClient` in subscriber mode,
the two `Bun.write` stream failures, and the whole `Bun.Image` section.
