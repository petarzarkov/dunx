import { brotliCompressSync, constants } from 'node:zlib';

/**
 * The content codings this package produces.
 *
 * `br` is the header token; the encoders call it `brotli`. Before Bun 1.4.3
 * `CompressionStream` accepted a `level` and ignored it, so brotli ran at 11 and
 * took 4.3 ms on a 5 KB JSON body. At `BROTLI_QUALITY` it takes 31 us to 327
 * bytes, against zstd's 9 us to 377 and gzip's 17 us to 593.
 *
 * `deflate` is absent because Bun's two encoders disagree: `Bun.deflateSync` emits
 * raw DEFLATE while `CompressionStream('deflate')` emits zlib, which is what the
 * header is defined as. Nothing reconciles them, so offering it would flip wire
 * format at the buffering threshold. Measured on Bun 1.4.0; see docs/bun-apis.md.
 */
export const CompressionEncoding = Object.freeze({
  ZSTD: 'zstd',
  BR: 'br',
  GZIP: 'gzip',
} as const);
export type CompressionEncoding =
  (typeof CompressionEncoding)[keyof typeof CompressionEncoding];

/**
 * The one brotli quality both encoders use, so `brotliCompressSync` and the
 * stream emit the same bytes and the format cannot shift at the buffering
 * threshold. 4 is where size stops falling faster than time rises.
 */
export const BROTLI_QUALITY = 4;

/** The buffered encoder for a coding. */
export const encodeSync = (
  encoding: CompressionEncoding,
  data: Uint8Array<ArrayBuffer>,
): Uint8Array => {
  switch (encoding) {
    case CompressionEncoding.ZSTD:
      return Bun.zstdCompressSync(data);
    case CompressionEncoding.BR:
      return brotliCompressSync(data, {
        params: { [constants.BROTLI_PARAM_QUALITY]: BROTLI_QUALITY },
      });
    case CompressionEncoding.GZIP:
      return Bun.gzipSync(data);
  }
};

/** The streaming encoder for a coding. */
export const compressionStream = (
  encoding: CompressionEncoding,
): CompressionStream =>
  encoding === CompressionEncoding.BR
    ? new CompressionStream('brotli', { level: BROTLI_QUALITY })
    : new CompressionStream(encoding);

/**
 * `application/*` types worth encoding. Everything `text/*` is compressible and
 * matched by prefix, and anything ending `+json` or `+xml` is matched by suffix,
 * so this set only has to carry the names that are neither.
 */
const COMPRESSIBLE: ReadonlySet<string> = new Set([
  'application/graphql',
  'application/graphql-response+json',
  'application/javascript',
  'application/json',
  'application/manifest+json',
  'application/wasm',
  'application/x-javascript',
  'application/x-ndjson',
  'application/xml',
  'image/svg+xml',
]);

/**
 * Types carrying a stream with no end, which no encoder here can take. The
 * buffered path reads to `done` to size the body, which an event stream only
 * reaches on disconnect, and streaming through `CompressionStream` is no
 * alternative: gzip emits its header and nothing more until the writable closes
 * (Bun 1.4.2, 20 events over 200 ms reached the reader as 0 payload bytes).
 *
 * The content type is the only signal before the body is read; any other
 * streaming type opts out with `cache-control: no-transform`, checked first.
 */
const ENDLESS: ReadonlySet<string> = new Set(['text/event-stream']);

/**
 * Whether a `content-type` is worth encoding.
 *
 * An already-compressed payload - a JPEG, an MP4, a zip - comes out of a second
 * pass slightly larger, having spent the CPU to get there. The default answers
 * no to anything it does not recognise, so a new binary type is skipped rather
 * than wasted on.
 */
export const isCompressibleType = (contentType: string | null): boolean => {
  if (contentType === null) return false;
  const type = contentType.split(';')[0]?.trim().toLowerCase() ?? '';
  if (ENDLESS.has(type)) return false;
  if (type.startsWith('text/')) return true;
  if (type.endsWith('+json') || type.endsWith('+xml')) return true;
  return COMPRESSIBLE.has(type);
};

/** Whether this runtime has both encoders for a coding: the sync one and the stream. */
const encodable = (encoding: CompressionEncoding): boolean => {
  if (!Object.values(CompressionEncoding).includes(encoding)) return false;
  try {
    encodeSync(encoding, new Uint8Array(0));
    compressionStream(encoding);
  } catch {
    return false;
  }
  if (encoding !== CompressionEncoding.BR) return true;
  // 1.4.3 started validating `level` in the release that started applying it, so
  // an out-of-range one throwing is what says the quality above is honoured.
  try {
    new CompressionStream('brotli', { level: 12 });
    return false;
  } catch {
    return true;
  }
};

export interface CompressionOptionsInit {
  /**
   * The codings offered, most preferred first. A tie in the client's q-values is
   * broken by this order.
   *
   * `zstd` leads for speed: 7.7 us to 372 bytes on a 6.4 KB JSON body where gzip
   * takes 16.1 us to reach 576. On a 116 KB document the sizes land within 0.2%,
   * so the size advantage narrows with the body while the time one does not.
   * `br` follows for a client without zstd, which is Safari, sending it 45% fewer
   * bytes than gzip would.
   *
   * @default ['zstd', 'br', 'gzip'], without `br` on a Bun older than 1.4.3
   */
  readonly encodings?: readonly CompressionEncoding[];
  /**
   * Bodies below this many bytes are sent as they are.
   *
   * Only applied when the response declares a `content-length`. A short JSON body
   * grows under gzip - the header and trailer alone are 18 bytes - and the round
   * trip through a compressor is time spent to send more.
   *
   * @default 1024
   */
  readonly threshold?: number;
  /** Which `content-type`s to encode. @default isCompressibleType */
  readonly filter?: (contentType: string | null) => boolean;
}

/**
 * A class, not an interface, so it is a runtime value `@dunx/transform` can record
 * at an injection site - the same reason `StaticOptions` and `ThrottleOptions` are.
 */
export class CompressionOptions {
  readonly encodings: readonly CompressionEncoding[];
  readonly threshold: number;
  readonly filter: (contentType: string | null) => boolean;

  constructor(init: CompressionOptionsInit = {}) {
    // The default drops what this runtime cannot encode; a list the app wrote is
    // held to every entry.
    this.encodings =
      init.encodings ??
      [
        CompressionEncoding.ZSTD,
        CompressionEncoding.BR,
        CompressionEncoding.GZIP,
      ].filter(encodable);
    // `engines.bun` is not enforced by `bun install`, so a runtime missing an
    // encoder can still boot this. Checked once here so it is a boot error
    // naming the coding, rather than a TypeError on the first request that
    // negotiates it.
    const missing = this.encodings.filter((encoding) => !encodable(encoding));
    if (missing.length > 0) {
      throw new Error(
        `Bun ${Bun.version} cannot encode ${missing.join(', ')}. ` +
          'Pass `encodings` without it, or upgrade Bun.',
      );
    }
    this.threshold = init.threshold ?? 1024;
    this.filter = init.filter ?? isCompressibleType;
  }
}
