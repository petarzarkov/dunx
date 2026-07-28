import { ImageError, ImageErrorCode, toImageError } from './errors.js';

/**
 * Anything this package will decode.
 *
 * `BunFile` is a `Blob`, and `Buffer` is an `ArrayBufferView`, so both are
 * already covered. A `string` is a filesystem path or a `data:` URL —
 * `Bun.Image` accepts both, and so does this.
 *
 * Deliberately not accepted: `Response` and `ReadableStream`. `Bun.Image`
 * rejects them with `ERR_INVALID_ARG_TYPE`; call `.blob()` first.
 */
export type ImageSource = string | ArrayBuffer | ArrayBufferView | Blob;

const isDataUrl = (value: string): boolean => value.startsWith('data:');

const view = (input: ArrayBufferView): Uint8Array =>
  new Uint8Array(
    input.buffer as ArrayBuffer,
    input.byteOffset,
    input.byteLength,
  );

/**
 * Read a source down to bytes.
 *
 * Everything is normalised here rather than handed to `Bun.Image` as-is,
 * because content-based format detection needs the leading bytes before any
 * pipeline is built, and because a failed read has to surface as an
 * `ImageError` rather than a raw syscall throw.
 */
export const readSource = async (source: ImageSource): Promise<Uint8Array> => {
  if (typeof source === 'string') {
    if (isDataUrl(source)) {
      try {
        // `fetch` resolves `data:` URLs natively, with no network involved.
        return new Uint8Array(await (await fetch(source)).arrayBuffer());
      } catch (cause) {
        throw new ImageError(
          ImageErrorCode.UNREADABLE_SOURCE,
          'could not decode the data: URL source',
          cause,
        );
      }
    }
    try {
      return await Bun.file(source).bytes();
    } catch (cause) {
      throw toImageError(cause, `could not read image at ${source}`);
    }
  }

  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) return view(source);

  // Checked rather than duck-typed: `Response` and `ReadableStream` are the
  // near-misses, and `Bun.Image` refuses both. Say so instead of decoding a
  // response body as if it were image bytes.
  if (!(source instanceof Blob)) {
    throw new ImageError(
      ImageErrorCode.UNREADABLE_SOURCE,
      'unsupported image source: expected a path string, a data: URL, an ' +
        'ArrayBuffer, a TypedArray, a Buffer, a Blob or a BunFile',
    );
  }

  try {
    return await source.bytes();
  } catch (cause) {
    throw toImageError(cause, 'could not read the image blob');
  }
};
