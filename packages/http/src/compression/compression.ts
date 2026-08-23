import type { BunRequest } from 'bun';
import type { RouteContext } from '../server/context.js';
import type { Middleware, Next } from '../server/middleware.js';
import { negotiate } from './negotiate.js';
import { CompressionEncoding, CompressionOptions } from './options.js';

/**
 * Exactly what `Response.body` is, so a stream this file builds pipes into a
 * `CompressionStream` on the same terms the original body does.
 */
type BodyStream = NonNullable<Response['body']>;

/** Statuses defined to carry no body, so there is nothing to encode. */
const BODYLESS: ReadonlySet<number> = new Set([204, 205, 304]);

/**
 * Above this many bytes, encode as a stream instead of buffering.
 *
 * The buffered path is the faster one and the only one that can still declare a
 * `content-length` - 15.6 us against 23.2 for a 6.4 KB body - but it holds the
 * whole response in memory to get there. A megabyte is where that stops being a
 * good trade for a payload that is already streaming past.
 */
const BUFFER_LIMIT = 1024 * 1024;

/**
 * The body, buffered, or a stream that replays what was read.
 *
 * A handler's `Response` almost never declares a `content-length` - Bun computes
 * it at serialization rather than putting it on the object - so an absent header
 * says nothing about size and reading is the only way to apply a threshold.
 *
 * Reading stops at `limit`, past which the response is handed back as a stream
 * with the consumed chunks in front, so a large download is never held whole.
 */
const buffer = async (
  body: BodyStream,
  limit: number,
): Promise<
  { readonly bytes: Uint8Array<ArrayBuffer> } | { readonly rest: BodyStream }
> => {
  const reader = body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > limit) {
      return {
        rest: new ReadableStream<Uint8Array<ArrayBuffer>>({
          start: (controller) => {
            for (const chunk of chunks) controller.enqueue(chunk);
          },
          // The same reader continues, so nothing is read twice and the lock is
          // never handed back to a second consumer.
          pull: async (controller) => {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          },
          cancel: (reason) => reader.cancel(reason),
        }),
      };
    }
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes };
};

const declaredLength = (headers: Headers): number | undefined => {
  const raw = headers.get('content-length');
  if (raw === null) return undefined;
  const length = Number.parseInt(raw, 10);
  return Number.isFinite(length) ? length : undefined;
};

/**
 * Encoding changes the bytes, so a strong validator no longer describes them.
 * Weakening it keeps the entity comparison a client does for `If-None-Match`
 * honest instead of dropping the header and losing revalidation.
 */
const weakenETag = (headers: Headers): void => {
  const etag = headers.get('etag');
  if (etag !== null && !etag.startsWith('W/')) headers.set('etag', `W/${etag}`);
};

/**
 * Set on every response this middleware *considered*, not only the ones it
 * encoded. A shared cache that stored the gzip body without it would go on to
 * serve those bytes to a client that never asked for gzip.
 */
const varyOnEncoding = (headers: Headers): void => {
  const existing = headers.get('vary');
  if (existing === null) {
    headers.set('vary', 'accept-encoding');
    return;
  }
  if (existing.trim() === '*') return;
  const listed = existing
    .split(',')
    .some((field) => field.trim().toLowerCase() === 'accept-encoding');
  if (!listed) headers.set('vary', `${existing}, accept-encoding`);
};

const encodeSync = (
  encoding: CompressionEncoding,
  data: Uint8Array<ArrayBuffer>,
): Uint8Array => {
  switch (encoding) {
    case CompressionEncoding.ZSTD:
      return Bun.zstdCompressSync(data);
    case CompressionEncoding.GZIP:
      return Bun.gzipSync(data);
  }
};

/**
 * Response compression, on Bun's own compressors. Not installed by default, and
 * registered by the app rather than a module:
 *
 * ```ts
 * const app = await HttpFactory.create(AppModule, { imports: [CompressionModule.forRoot()] });
 * app.use(Compression);
 * ```
 *
 * An app that never registers it pays nothing. Position is the app's: compression
 * belongs inside request logging and outside anything reading the body it made.
 *
 * Two encoders. A known length under `BUFFER_LIMIT` goes through the sync
 * compressors, which keep an accurate `content-length`; anything larger or
 * streamed goes through `CompressionStream` and loses the header.
 */
export class Compression implements Middleware {
  readonly #options: CompressionOptions;

  constructor(options: CompressionOptions) {
    this.#options = options;
  }

  /** Whether the response is a candidate at all, before the client is consulted. */
  #considers(res: Response): boolean {
    if (BODYLESS.has(res.status) || res.status === 206) return false;
    // Already encoded by the handler, or by something further in.
    if (res.headers.has('content-encoding')) return false;
    // RFC 9111: an intermediary must not change the payload when this is set.
    if (res.headers.get('cache-control')?.includes('no-transform') === true) {
      return false;
    }
    return this.#options.filter(res.headers.get('content-type'));
  }

  async handle(
    req: BunRequest,
    _ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    const res = await next();
    const body = res.body;
    if (body === null || !this.#considers(res)) return res;

    // Mutated in place. Headers on a `Response` are writable in Bun (probed), so
    // the pass-through below costs one header write rather than a rebuilt
    // response.
    varyOnEncoding(res.headers);

    const encoding = negotiate(
      req.headers.get('accept-encoding'),
      this.#options.encodings,
    );
    if (encoding === undefined) return res;

    const declared = declaredLength(res.headers);
    // A declared length short-circuits the read. Rare, since Bun does not put the
    // header on a Response, but a handler that sets one deserves to be believed.
    if (declared !== undefined && declared < this.#options.threshold)
      return res;

    const headers = new Headers(res.headers);
    headers.set('content-encoding', encoding);
    weakenETag(headers);

    const source =
      declared !== undefined && declared > BUFFER_LIMIT
        ? { rest: body }
        : await buffer(body, BUFFER_LIMIT);

    if ('rest' in source) {
      // The encoded length is not known until the stream ends.
      headers.delete('content-length');
      return new Response(
        source.rest.pipeThrough(new CompressionStream(encoding)),
        { status: res.status, statusText: res.statusText, headers },
      );
    }

    // Now the size is known, so the threshold can finally be applied. The body was
    // consumed to learn it, so the untouched case is rebuilt rather than returned.
    if (source.bytes.byteLength < this.#options.threshold) {
      const passthrough = new Headers(res.headers);
      passthrough.set('content-length', String(source.bytes.byteLength));
      return new Response(source.bytes, {
        status: res.status,
        statusText: res.statusText,
        headers: passthrough,
      });
    }

    const encoded = encodeSync(encoding, source.bytes);
    headers.set('content-length', String(encoded.byteLength));
    return new Response(encoded, {
      status: res.status,
      statusText: res.statusText,
      headers,
    });
  }
}
