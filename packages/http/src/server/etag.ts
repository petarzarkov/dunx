import { HttpStatusCode } from './status.js';

export interface EtagOptions {
  /**
   * `W/"..."` when true, `"..."` when false. Weak is the default, as it is in
   * Express: `If-None-Match` compares weakly either way (RFC 9110 13.1.2), and
   * only `If-Range` needs a strong tag, which these responses never answer.
   * `Compression` weakens a strong tag on anything it encodes.
   *
   * @default true
   */
  readonly weak?: boolean;
}

/**
 * What `Response.json` sets, so a body serialized by hand is typed as one it
 * built. `@dunx/openapi` sends its document under it.
 */
export const JSON_CONTENT_TYPE = 'application/json;charset=utf-8';

/** Each entity-tag in a list, captured without its `W/`. */
const ENTITY_TAG = /(?:W\/)?("[^"]*")/g;

/**
 * The entity-tag for a body: xxHash3 over its UTF-8 bytes, seed 0, as 16 hex
 * digits, so the same bytes give the same tag in every process and on every
 * replica. `W/"..."` when `weak`.
 */
export const entityTag = (body: string | Uint8Array, weak: boolean): string => {
  const hex = Bun.hash.xxHash3(body).toString(16).padStart(16, '0');
  return weak ? `W/"${hex}"` : `"${hex}"`;
};

/**
 * Whether an `If-None-Match` value names `etag`, by weak comparison: `W/"a"`
 * and `"a"` match. `*` matches any current representation.
 */
export const noneMatch = (header: string, etag: string): boolean => {
  if (header.trim() === '*') return true;
  const opaque = etag.startsWith('W/') ? etag.slice(2) : etag;
  // Cheap rejection first: a tag not in the string at all cannot be in the list.
  if (!header.includes(opaque)) return false;
  for (const [, tag] of header.matchAll(ENTITY_TAG)) {
    if (tag === opaque) return true;
  }
  return false;
};

/**
 * `ETag` on what a `GET` handler returns, and a 304 when `If-None-Match` names
 * it. Built once at `listen()` when `HttpOptions.etag` is on, and handed to
 * every `GET` route.
 *
 * **Only a value dunx serializes is hashed.** The bytes are in hand before a
 * `Response` exists, so tagging is synchronous and the direct path stays
 * direct. A `Response` the handler built is never read: no public API tells a
 * buffered body from a stream or a file without consuming it, and `blob()` on
 * a stream that never ends never resolves. Its own `ETag`, when it sets one,
 * is honoured by {@link conditionalGet}.
 *
 * Measured in docs/architecture/constraints.md, "ETags and conditional GET".
 */
export class EntityTags {
  readonly #weak: boolean;

  constructor(options: EtagOptions) {
    this.#weak = options.weak ?? true;
  }

  /** A 200 for `value`, tagged, or the 304 that replaces it. */
  json(value: unknown, req: Request): Response {
    const text = JSON.stringify(value);
    // A function or a symbol, which `Response.json` answers on its own terms.
    if (text === undefined) return Response.json(value);
    const etag = entityTag(text, this.#weak);
    const header = req.headers.get('if-none-match');
    const response =
      header !== null && noneMatch(header, etag)
        ? new Response(null, { status: HttpStatusCode.NOT_MODIFIED })
        : new Response(text);
    // Set, not passed in the init: an init record measured 0.6 us more a
    // request. `content-type` stays on the 304, as on Bun's own for a static
    // route, so `Compression` can tell it would have encoded the 200.
    response.headers.set('content-type', JSON_CONTENT_TYPE);
    response.headers.set('etag', etag);
    return response;
  }
}

/**
 * `response`, or the 304 that replaces it when it is a 200 whose `ETag` the
 * request's `If-None-Match` names. The headers are kept but `content-length`,
 * which RFC 9110 8.6 allows only when it is the 200's. A handler's own
 * `Response` goes through this under `etag`, and `@dunx/openapi`'s document
 * always does.
 */
export const conditionalGet = (response: Response, req: Request): Response => {
  if (response.status !== HttpStatusCode.OK) return response;
  const etag = response.headers.get('etag');
  const header = req.headers.get('if-none-match');
  if (etag === null || header === null || !noneMatch(header, etag)) {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.delete('content-length');
  // Rejects when the handler already locked the body with a reader.
  void response.body?.cancel().catch(() => undefined);
  return new Response(null, { status: HttpStatusCode.NOT_MODIFIED, headers });
};
