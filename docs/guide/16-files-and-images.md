# Files and images

Two subpaths, both built entirely on Bun primitives. `@dunx/infra/files` is one
storage contract over `Bun.file`, `Bun.write`, `Bun.Glob` and `Bun.S3Client`.
`@dunx/infra/images` is decode, inspect and transform on `Bun.Image`.

Neither needs an install. No `@aws-sdk/*`, no `sharp`, no `jimp`, no
`image-size`, no native module to compile.

## Storage

```ts
import { Storage } from '@dunx/infra/files';

export class Uploads {
  constructor(private readonly storage: Storage) {}

  async save(name: string, body: ReadableStream<Uint8Array>): Promise<number> {
    return this.storage.write(`uploads/${name}`, body);
  }
}
```

`Storage` is an abstract class, so it is both the injectable contract and the
token. Whether the bytes land on a disk or in a bucket is decided in one `forRoot`
call, and nothing above changes.

### Setup

```ts
import { Module } from '@dunx/core';
import { FilesModule, LocalStorageOptions } from '@dunx/infra/files';

@Module({
  imports: [FilesModule.forRoot(new LocalStorageOptions('/var/lib/app/data'))],
  providers: [Uploads],
})
export class StorageModule {}
```

S3, or R2, or MinIO, or Spaces, is the same call with different options:

```ts
import { FilesModule, S3StorageOptions } from '@dunx/infra/files';

FilesModule.forRoot(
  new S3StorageOptions(
    { bucket: 'invoices', region: 'eu-west-1' },
    'tenant-a', // optional key prefix
  ),
);
```

Anything omitted from the client options falls back to the environment:
`S3_BUCKET` or `AWS_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`AWS_REGION`, `AWS_ENDPOINT`. That is `Bun.S3Client`'s own resolution, and this
package adds none of its own.

`forRootAsync` when the configuration has to be loaded, or injected. The root
existing before `LocalStorageOptions` names it is a real case, and creating it is
async, which is the whole reason the factory may await:

```ts
FilesModule.forRootAsync({
  useFactory: async (workspace: Workspace) =>
    new LocalStorageOptions(await workspace.create()),
  inject: [Workspace],
});
```

Both bind the same two tokens: `Storage`, and the `StorageOptions` that selected
it. The module never branches on the backend, because the backend is whichever
`StorageOptions` subclass got configured and `options.create()` is what builds it.
Adding a backend is a subclass, not a branch.

### `LocalStorageOptions`

The constructor is `(root: string, createPath = true)`. `root` is resolved to an
absolute path, every key is resolved against it and may not escape it, and
`createPath` creates missing parent directories on write.

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

`write` takes a `string`, `Uint8Array`, `ArrayBuffer`, `Blob` or `ReadableStream`,
and returns the byte count. `delete` is idempotent on both backends: removing a
key that was never there is not an error. A missing key raises
`FileNotFoundError` whichever backend you are on.

Keys are always relative to the storage root: the configured directory locally,
the configured prefix on S3. What `write` takes is what `list` and `stat` give
back, so putting a bucket behind a prefix does not ripple into call sites.

### Errors

| Class                       | When                                       |
| --------------------------- | ------------------------------------------ |
| `FileNotFoundError`         | A backend-neutral ENOENT, mapped from both |
| `PathTraversalError`        | A key that escapes the storage root        |
| `UnsupportedOperationError` | `presign()` on a local disk                |
| `StorageError`              | The base for all three                     |

### Listing

`list` is an `AsyncIterable`, so a bucket with a million objects is paged rather
than accumulated:

```ts
for await (const entry of storage.list({ prefix: 'reports', glob: '*.csv' })) {
  console.log(entry.key);
}
```

Details worth knowing:

- **Local listings include dotfiles.** S3 has no notion of a hidden object, so
  neither does this.
- **Order is whatever the backend gives**: lexicographic on S3, filesystem order
  for a glob scan. Sorting would mean buffering the whole listing.
- **`size` and `lastModified` on a `ListEntry` are set only when the backend hands
  them over with the listing.** S3 does; a glob scan does not, and statting every
  hit would turn one listing into N syscalls. Call `stat()` when you need them.
- **A prefix that does not exist lists as empty** on both backends rather than
  raising.
- **`list({ glob })` on S3 costs more than it looks.** S3 has no glob, so it lists
  by prefix and applies the pattern to the keys that come back. The page size is
  therefore not capped by `limit` when a glob is in play, because capping it would
  truncate before the filter ran.

### presign

S3 signs; a local disk cannot. `LocalStorage.presign()` throws
`UnsupportedOperationError` naming the key and what to do instead, rather than
returning a URL that does not work:

```
LocalStorage does not support presign(). Nothing signs "report.pdf" on a local
disk. Configure S3StorageOptions, or serve the bytes through your own route.
```

Signing is HMAC over the canonical request, so `S3Storage.presign()` is
**synchronous and never touches the network**. That is why it returns a `string`
rather than a promise.

```ts
const url = storage.presign('invoices/2026-01.pdf', {
  expiresIn: 900,
  method: 'PUT',
  type: 'application/pdf',
});
```

### Path traversal is rejected, not sanitised

Every key is resolved against the configured root, and one that lands outside it
raises `PathTraversalError` **before any syscall**:

```ts
await storage.read('../../etc/passwd'); // PathTraversalError
```

That covers `../`, an absolute key, an empty key, and the root itself. None of
those name a file the caller is entitled to.

The check is two checks, not one, and the order matters. A key is accepted or
refused **identically on every platform**: `..\..\etc` is one legal filename to
POSIX `resolve` but three segments to Windows, so `..` is checked as a segment on
**both separators** before the path is resolved at all. The boundary check then
catches what segments cannot, which is an absolute key or a root-relative one that
resolves out.

S3 keys get the same treatment. A key is opaque to S3, so a `..` in one was meant
as a path, and under a configured prefix it would escape it. There it is rejected
outright rather than collapsed.

**One thing this does not do.** `resolve` collapses segments textually, so a
symlink **inside** the root pointing outside it is still followed. Detecting that
needs `realpath`, which cannot answer for a file that does not exist yet. Do not
make the root writable by anything you would not trust with its contents.

### Streaming stays streaming

Nothing here buffers a whole file to satisfy the contract. `readStream` returns
`Bun.file().stream()`, or the S3 `GET` body, unread. A `ReadableStream` passed to
`write` is pumped chunk by chunk into a sink: a `FileSink` locally, a multipart
`NetworkSink` on S3. A file larger than memory transfers either way.

The sink is not a stylistic choice. Two `Bun.write` behaviours forced it, both
measured on Bun 1.3.14:

- **`Bun.write(path, stream)` silently writes the wrong bytes.** It matches no
  overload, so the stream is stringified and the file contains the 23 bytes
  `[object ReadableStream]`. No error, no warning.
- **`Bun.write(path, new Response(stream))` never settles** when the response body
  is itself a stream. `new Response('string')` settles normally.

And a third, which is why a streaming local write does an empty `Bun.write`
first: **`Bun.file(path).writer()` does not truncate and does not create parent
directories.** Writing `"bb"` over a 20-byte file leaves
`bbAAAAAAAAAAAAAAAAAA`. The empty write does both jobs, then the sink streams in
over the top.

Two places where a call costs more than it looks:

- **`readStream` does one `exists()` first**, so a missing key rejects the promise
  instead of handing back a stream that fails on the consumer's first `read()`.
  On S3 that is one extra `HEAD`. The `GET` has not started; the returned stream
  is still lazy.
- `Bun.file().stream()` is itself lazy: it opens on the first read. That is what
  the `exists()` check compensates for.

## Images

```ts
import { Images, ImagesModule, ImageFit } from '@dunx/infra/images';
import { Module } from '@dunx/core';

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

`forRoot` also takes a function, awaited, so asynchronously loaded options need
nothing extra:

```ts
ImagesModule.forRoot(async () => ({ quality: await settings.imageQuality() }));
```

`forRootAsync` is for the one thing that cannot do, which is **injecting**:

```ts
ImagesModule.forRootAsync({
  useFactory: (config: AppConfigService) => ({
    quality: config.get('images').quality,
    maxWidth: 1024,
  }),
  inject: [AppConfigService],
});
```

`Images` is bound through an explicit factory rather than as a bare class, so this
area works with or without the `@dunx/transform` preload. You still need the
preload for your **own** classes to inject `Images` by constructor.

### Configuration

`ImagesOptions` is an `abstract class`, so it is a usable injection token; an
`interface` would erase and `@dunx/transform` would record the parameter as
unresolved. Inject it to read the effective configuration.

| Option           | Default                   | Effect                                           |
| ---------------- | ------------------------- | ------------------------------------------------ |
| `quality`        | `80`                      | Encoder quality when a call does not override it |
| `maxPixels`      | `0x3fff * 0x3fff`         | Reject a source over this, before pixel alloc    |
| `autoOrient`     | `true`                    | Apply the JPEG EXIF `Orientation` tag first      |
| `allowedFormats` | every container Bun reads | Gates both decoding and encoding                 |
| `maxWidth`       | `undefined`               | Clamps every requested resize width              |
| `maxHeight`      | `undefined`               | Clamps every requested resize height             |

`maxPixels` matches Bun's own default, and is checked after the header is parsed
but **before any pixel buffer is allocated**, so a small file declaring an enormous
canvas is rejected cheaply.

`maxWidth` and `maxHeight` **clamp** rather than refuse, so a request larger than
the ceiling is served smaller.

### Sources

`load()` takes a `BunFile`, a `Blob`, an `ArrayBuffer`, a `Uint8Array`, a
`Buffer`, a filesystem path, or a `data:` URL, and normalises all of them to
bytes. A `data:` URL is resolved through `fetch`, natively, with no network
involved.

A `Response` or a `ReadableStream` is refused with `ERR_IMAGE_UNREADABLE_SOURCE`.
`Bun.Image` rejects both with `ERR_INVALID_ARG_TYPE`; call `.blob()` first.

An `http(s)://` string is **not** fetched. `Bun.Image` treats it as a path, which
is an `ENOENT`.

### Format detection is content-based

The container is decided by **magic bytes, never by a filename**:

```ts
const pipeline = await images.load('avatar.png');
pipeline.format; // 'jpeg', if that is what the bytes are
```

`sniffFormat(bytes)` is the same check as a free function, `images.detect(bytes)`
is it on the service, and `images.supports(bytes)` folds it together with the
configured `allowedFormats`.

`ImageFormat` covers `jpeg`, `png`, `webp`, `heic`, `avif`, `bmp`, `tiff` and
`gif`. `EncodableFormat` is the subset Bun has an **encoder** for: `jpeg`, `png`,
`webp`, `heic`, `avif`. `bmp`, `tiff` and `gif` decode only.

Both are frozen objects plus an indexed-access union, not enums, so one name
serves as the value and the type.

### The pipeline is immutable

```ts
const source = await images.load(bytes);
const thumb = source.resize(64, 64); // source is unchanged
const hero = source.resize(1200); // and still 'source'
```

This is the single most important difference between `ImagePipeline` and
`Bun.Image` underneath it. **`Bun.Image` mutates and returns `this`**, so two
callers holding one instance silently reconfigure each other's transform. An
`ImagePipeline` returns a new value from every operation, can be shared and forked
freely, and re-runs the whole recipe from the original bytes on each terminal.

**Operations:** `resize`, `rotate`, `flip`, `flop`, `modulate`, `to`.

**Terminals:** `encode`, `toBytes`, `toBuffer`, `toBlob`, `toBase64`, `toDataUrl`,
`toFile`, `placeholder`, `sourceMetadata`.

`encode()` is the one that reports real **output** dimensions:

```ts
const { bytes, format, mimeType, width, height } = await pipeline.encode();
```

Two read-only properties are free: `pipeline.format` is the container the source
bytes actually are, and `pipeline.outputFormat` is what a terminal will emit.

Nothing decodes until a terminal is awaited. State is recorded as a **record, not
a list**, because that is what the engine does: `Bun.Image` chainables overwrite,
so calling `.resize()` twice keeps only the second.

### Execution order is fixed

Regardless of the order you called them in, the pipeline runs:

```
autoOrient -> rotate -> flip/flop -> resize -> modulate
```

That is `Bun.Image`'s behaviour, not something dunx imposes, and knowing it saves
a confusing afternoon.

### `metadata()` is not a validity check

This is the sharpest edge in the whole API.

`Bun.Image.metadata()` answers from the container header and never decodes pixels,
so a **truncated file still reports its declared dimensions**:

```ts
await images.metadata(halfAFile); // { width: 64, height: 48, format: 'png' } - resolves!
await images.verify(halfAFile); // throws ImageError ERR_IMAGE_DECODE_FAILED
```

Use `metadata()` when you want the cheap header read, and `verify()` when the
pixels have to be known-good. `verify()` runs a full decode and then reports the
metadata.

`sourceMetadata()` on a pipeline has the same property, and one more: **it ignores
the chain**. `load(x).resize(32, 24).sourceMetadata()` still reports the input's
dimensions and the input's format. So does `placeholder()`.

### `placeholder()`

A ThumbHash low-quality placeholder of the **source**, as a
`data:image/png;base64,...` URL. Roughly 1.4 KB for a photo, at most 32px on the
long edge.

### Errors

Everything throws `ImageError extends AppError`, carrying a `code` and the
original throw as `cause`:

```ts
try {
  await images.verify(upload);
} catch (error) {
  if (
    error instanceof ImageError &&
    error.code === ImageErrorCode.DECODE_FAILED
  ) {
    // truncated or corrupted payload
  }
}
```

Bun's own codes pass through unchanged. Two are added here:
`ERR_IMAGE_UNREADABLE_SOURCE` for a source that could not be read at all, and
`ERR_IMAGE_FORMAT_NOT_ALLOWED` for one excluded by `allowedFormats`.

| Condition                                    | Type        | `code`                          |
| -------------------------------------------- | ----------- | ------------------------------- |
| No container signature matched               | `Error`     | `ERR_IMAGE_UNKNOWN_FORMAT`      |
| Header valid, pixels truncated or corrupt    | `Error`     | `ERR_IMAGE_DECODE_FAILED`       |
| HEIC/AVIF/TIFF with no OS codec              | `Error`     | `ERR_IMAGE_FORMAT_UNSUPPORTED`  |
| Over `maxPixels` (raised even by `metadata`) | `Error`     | `ERR_IMAGE_TOO_MANY_PIXELS`     |
| Rotation not a multiple of 90                | `TypeError` | `ERR_INVALID_ARG_TYPE`          |
| Unknown resize `filter`                      | `TypeError` | `ERR_INVALID_ARG_TYPE`          |
| Input is a `Response`/`ReadableStream`       | `TypeError` | `ERR_INVALID_ARG_TYPE`          |
| Missing path or directory                    | `Error`     | raw syscall: `ENOENT`, `ENODEV` |

`ERR_IMAGE_ENCODE_FAILED` and `ERR_INVALID_STATE` are declared in Bun's types but
were not reachable in probing.

### What `Bun.Image` does that will surprise you

`Bun.Image` is barely documented upstream. Everything here was measured on Bun
1.3.14 and is pinned by tests in `@dunx/infra`.

**Silent clamping, no throw.** `resize(0)`, `resize(-5)` and `resize(1.5)` all
produce a 1x1 image. `quality: 0` behaves as the minimum and `quality: 101` as
`100`. A bogus option **key** is ignored, but a bogus option **value** for
`filter` throws.

**Decode-only formats fall back to PNG.** Bun decodes `gif` (first frame), `bmp`
and `tiff` but has no encoder for them. Bun's docs say a terminal with no format
setter re-encodes in the source format; for those three it actually emits **PNG**,
and `blob().type` reports `image/png`. `ImagePipeline.outputFormat` tells you this
before you run anything.

**`width`/`height` on a raw `Bun.Image` are `-1`** until a terminal has been
awaited, and then hold whatever that terminal produced. `encode()` exists so you
never have to reason about that.

**Lazy and re-runnable.** The pipeline runs on a worker thread when a terminal is
awaited, and awaiting a second terminal re-runs it rather than throwing. Parallel
terminals via `Promise.all` are safe.

**Platform.** `Bun.Image.backend` is `'bun'` on Linux and `'system'` on
macOS/Windows. On Linux, **HEIC and AVIF encoding is unavailable**, `tiff` decode
fails with `ERR_IMAGE_FORMAT_UNSUPPORTED`, and setting `backend = 'system'` does
not change either. The clipboard statics are inert there too.

`allowedFormats` defaults to every container Bun can identify, including HEIC and
AVIF, because a machine with the codec can use them and the runtime's own
`ERR_IMAGE_FORMAT_UNSUPPORTED` is the honest answer where it cannot. Narrow it if
you want the refusal to be a policy decision instead.

**Undocumented but present.** `Bun.file(path).image()` and `Blob.prototype.image()`
both exist and return a `Bun.Image`. `linear` works as a resize filter, an alias
for `bilinear`, even though it is missing from the error message listing the valid
names.

## Related

- [Configuration](./11-configuration.md) for `forRootAsync` and `AppConfigService`
- [Queues](./14-queues.md), since image work is the archetypal job to move off the
  request path
- `packages/infra/README.md` for the rest of `@dunx/infra`
