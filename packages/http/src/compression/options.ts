/**
 * The content codings this package produces.
 *
 * **Brotli is absent, and that is a measurement rather than an oversight.** Bun
 * implements it - `new CompressionStream('brotli')` works - but at 6,344 us to
 * encode a 6.4 KB JSON body against gzip's 23 us and zstd's 24 us, roughly 275x.
 * The `level` argument that would fix it is accepted and ignored: `{ level: 4 }`
 * encodes in 6,345 us and produces the same 339 bytes as the default. Brotli
 * belongs on a build artefact compressed once, not on a response encoded per
 * request. Note also that the `CompressionStream` format is spelled `brotli`
 * while the HTTP token is `br`, so the two never lined up anyway.
 *
 * **`deflate` is absent for a second and worse reason: Bun's two encoders disagree
 * about what it means.** `Bun.deflateSync` emits raw DEFLATE (first bytes
 * `cb 48`), while `CompressionStream('deflate')` emits zlib (`78 9c`), which is
 * what `Content-Encoding: deflate` is defined as. No option reconciles them -
 * `library`, `windowBits` and `level` all leave `deflateSync` raw - so offering
 * the coding would flip wire format at the buffering threshold and serve bytes a
 * strict client rejects. `gzip` is taken by everything that would have accepted
 * `deflate`. Measured on Bun 1.4.0; see docs/bun-apis.md.
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
   * broken by this order, so it is a real preference and not just a filter.
   *
   * The default puts `zstd` first for speed. On a 6.4 KB JSON body zstd encodes to
   * 372 bytes in 7.7 us where gzip takes 16.1 us to reach 576; on a 116 KB OpenAPI
   * document the two land within 0.2% of each other (9,603 against 9,587), so the
   * size advantage narrows with the body while the time one does not. A client
   * that does not send `zstd` in `accept-encoding` gets gzip, so the order costs
   * nothing to state.
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
    // `engines.bun` allows 1.3, where `zstd` may be missing from either encoder.
    // Checked once here so an unsupported runtime is a boot error naming the
    // coding, rather than a TypeError on the first request that negotiates it.
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
