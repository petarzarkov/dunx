# @dunx/files

One storage contract, two backends, zero dependencies.

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

Built on `Bun.file`, `Bun.write`, `Bun.Glob` and `Bun.S3Client`. No
`@aws-sdk`, no `glob`, no `mime-types`.

## Setup

```ts
import { AppFactory, Module } from '@dunx/core';
import { FilesModule, LocalStorageOptions } from '@dunx/files';

@Module({
  imports: [FilesModule.forRoot(new LocalStorageOptions('/var/lib/app/data'))],
  providers: [Uploads],
})
class AppModule {}

const app = await AppFactory.create(AppModule);
```

S3 — or R2, or MinIO, or Spaces — is the same call with different options:

```ts
import { FilesModule, S3StorageOptions } from '@dunx/files';

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

There is no separate async mechanism. dunx resolves eagerly and settles async
factories before any constructor runs, so `forRootAsync` is `forRoot` with a
factory in front of it. Both bind the same two tokens: `Storage`, and the
`StorageOptions` that selected it.

## The contract

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

### presign

S3 signs; a local disk cannot. `LocalStorage.presign()` throws
`UnsupportedOperationError` naming the key and what to do instead, rather than
returning a URL that does not work:

```
LocalStorage does not support presign(). Nothing signs "report.pdf" on a local
disk. Configure S3StorageOptions, or serve the bytes through your own route.
```

Signing is HMAC over the canonical request, so `S3Storage.presign()` is
synchronous and never touches the network.

## Path traversal is rejected, not sanitised

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

## Streaming stays streaming

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

## Listing details worth knowing

- Local listings include dotfiles. S3 has no notion of a hidden object, so
  neither does this.
- Order is whatever the backend gives: lexicographic on S3, filesystem order for
  a glob scan. Sorting would mean buffering the whole listing.
- `size` and `lastModified` on a `ListEntry` are set only when the backend hands
  them over with the listing. S3 does; a glob scan does not, and statting every
  hit would turn one listing into N syscalls. Call `stat()` when you need them.
- A prefix that does not exist lists as empty on both backends rather than
  raising.
