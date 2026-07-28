# @dunx/images

Decode, inspect and transform images on `Bun.Image`. No `sharp`, no `jimp`, no
native module install — zero dependencies beyond `@dunx/core`.

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

## Sources

`load()` takes a `BunFile`, a `Blob`, an `ArrayBuffer`, a `Uint8Array`, a
`Buffer`, a filesystem path, or a `data:` URL, and normalises all of them to
bytes. A `Response` or a `ReadableStream` is refused with
`ERR_IMAGE_UNREADABLE_SOURCE` — call `.blob()` first.

## Format detection is content-based

The container is decided by magic bytes, never by a filename. A `.png` holding
JPEG bytes reports `jpeg`:

```ts
const pipeline = await images.load('avatar.png');
pipeline.format; // 'jpeg'
```

`sniffFormat(bytes)` is the same check as a free function, and
`images.supports(bytes)` folds it together with the configured `allowedFormats`.

## The pipeline is immutable

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

## Errors

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

## `metadata()` is not a validity check

This is the sharpest edge in the whole API. `Bun.Image.metadata()` answers from
the container header and never decodes pixels, so a **truncated file still
reports its declared dimensions**:

```ts
await images.metadata(halfAFile); // { width: 64, height: 48, format: 'png' } — resolves!
await images.verify(halfAFile); // throws ImageError ERR_IMAGE_DECODE_FAILED
```

Use `metadata()` when you want the cheap header read, and `verify()` when the
pixels have to be known-good. `verify()` runs a full decode.

## Configuration

`ImagesOptions` is an `abstract class`, so it is a usable injection token — an
`interface` would erase and `@dunx/compiler` would record the parameter as
unresolved.

| Option           | Default                 | Effect                                          |
| ---------------- | ----------------------- | ----------------------------------------------- |
| `quality`        | `80`                    | Encoder quality when a call does not override it |
| `maxPixels`      | `0x3fff * 0x3fff`       | Reject a source over this, before pixel alloc   |
| `autoOrient`     | `true`                  | Apply the JPEG EXIF `Orientation` tag first     |
| `allowedFormats` | every container Bun reads | Gates both decoding and encoding              |
| `maxWidth`       | `undefined`             | Clamps every requested resize width             |
| `maxHeight`      | `undefined`             | Clamps every requested resize height            |

There is no `forRootAsync`. dunx resolves eagerly and settles factories before
any constructor runs, so pass a function and it is awaited:

```ts
ImagesModule.forRoot(async () => ({ quality: await settings.imageQuality() }));
```

`Images` is bound through an explicit factory, so `@dunx/images` works with or
without the `@dunx/compiler` preload. You still need the preload for your *own*
classes to inject `Images` by constructor.

## What `Bun.Image` actually does

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
`dataurl`/`toBase64`, the *source* dimensions after `metadata()`, and the
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

| Condition                                   | Type        | `code`                          |
| ------------------------------------------- | ----------- | ------------------------------- |
| No container signature matched              | `Error`     | `ERR_IMAGE_UNKNOWN_FORMAT`      |
| Header valid, pixels truncated or corrupt   | `Error`     | `ERR_IMAGE_DECODE_FAILED`       |
| HEIC/AVIF/TIFF with no OS codec             | `Error`     | `ERR_IMAGE_FORMAT_UNSUPPORTED`  |
| Over `maxPixels` (raised even by `metadata`) | `Error`     | `ERR_IMAGE_TOO_MANY_PIXELS`     |
| Rotation not a multiple of 90               | `TypeError` | `ERR_INVALID_ARG_TYPE`          |
| Unknown resize `filter`                     | `TypeError` | `ERR_INVALID_ARG_TYPE`          |
| Input is a `Response`/`ReadableStream`      | `TypeError` | `ERR_INVALID_ARG_TYPE`          |
| Missing path / directory                    | `Error`     | raw syscall: `ENOENT`, `ENODEV` |

`ERR_IMAGE_ENCODE_FAILED` and `ERR_INVALID_STATE` are declared in the types but
were not reachable in probing.

**Silent clamping.** `resize(0)`, `resize(-5)` and `resize(1.5)` all produce a
1x1 image instead of throwing. `quality: 0` behaves as the minimum and
`quality: 101` as `100`. A bogus *option key* is ignored, but a bogus option
*value* for `filter` throws.

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
