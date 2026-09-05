/**
 * The content codings this package produces.
 *
 * Brotli is absent on measurement: 6,344 us to encode a 6.4 KB JSON body against
 * gzip's 23 us, and the `level` argument that would fix it is accepted and
 * ignored. It belongs on a build artefact, not a per-request response.
 *
 * `deflate` is absent because Bun's two encoders disagree: `Bun.deflateSync` emits
 * raw DEFLATE while `CompressionStream('deflate')` emits zlib, which is what the
 * header is defined as. Nothing reconciles them, so offering it would flip wire
 * format at the buffering threshold. Measured on Bun 1.4.0; see docs/bun-apis.md.
 */
export const CompressionEncoding = Object.freeze({
  ZSTD: 'zstd',
  GZIP: 'gzip',
} as const);
export type CompressionEncoding =
  (typeof CompressionEncoding)[keyof typeof CompressionEncoding];

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
  if (type.startsWith('text/')) return true;
  if (type.endsWith('+json') || type.endsWith('+xml')) return true;
  return COMPRESSIBLE.has(type);
};

/** Whether this runtime has both encoders for a coding: the sync one and the stream. */
const encodable = (encoding: CompressionEncoding): boolean => {
  const sync =
    encoding === CompressionEncoding.ZSTD ? Bun.zstdCompressSync : Bun.gzipSync;
  if (typeof sync !== 'function') return false;
  try {
    new CompressionStream(encoding);
    return true;
  } catch {
    return false;
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
   *
   * @default ['zstd', 'gzip']
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
    this.encodings = init.encodings ?? [
      CompressionEncoding.ZSTD,
      CompressionEncoding.GZIP,
    ];
    // `engines.bun` is not enforced by `bun install`, so a 1.3 runtime where
    // `zstd` is missing from either encoder can still boot this. Checked once
    // here so it is a boot error naming the coding, rather than a TypeError on
    // the first request that negotiates it.
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
