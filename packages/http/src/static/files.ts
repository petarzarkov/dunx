import { join, normalize, resolve } from 'node:path';
import type { BunRequest } from 'bun';
import type { Middleware, Next } from '../server/middleware.js';
import type { RouteContext } from '../server/context.js';
import { StaticOptions } from './options.js';

/**
 * Static files, on `Bun.file`.
 *
 * Nest has `ServeStaticModule` over `serve-static`, which is Express middleware
 * doing its own `stat`, its own range parsing, its own ETag and its own MIME table.
 * None of that is needed here: `Bun.file(path)` handed to a `Response` already
 * streams, already sets `content-type` from the extension, already answers a
 * `Range` request, and does the whole thing with `sendfile(2)` rather than reading
 * into JavaScript. So this file is a **path check and a cache policy**, and that is
 * the entire justification for it existing.
 *
 * A middleware rather than routes, for the same reason the dashboard is one: the
 * file set is whatever is on disk at request time, and turning it into a
 * `Bun.serve` route table would mean walking a directory at boot and being wrong
 * the moment anything changed.
 */
export class StaticFiles implements Middleware {
  readonly #options: StaticOptions;
  readonly #root: string;
  readonly #prefix: string;

  constructor(options: StaticOptions) {
    this.#options = options;
    // Resolved once. Every request is compared against this, and re-resolving per
    // request would let a `cwd` change mid-process move the root.
    this.#root = resolve(options.root);
    this.#prefix = options.path === '/' ? '/' : `${options.path}/`;
  }

  /**
   * The file for a request path, or `undefined` if it escapes the root.
   *
   * **The traversal check is the point of this method.** `..` segments are removed
   * by `normalize`, but that alone is not enough: a root of `/srv/app` and a
   * request for `/srv/app-secrets` both start with the same string, so the guard
   * has to compare against the root **with a separator**. Both halves have to hold
   * or a caller reads the filesystem.
   */
  resolvePath(pathname: string): string | undefined {
    const relative = pathname.startsWith(this.#prefix)
      ? pathname.slice(this.#prefix.length)
      : pathname.slice(this.#options.path.length);

    // Percent-encoding first: `%2e%2e%2f` is `../` and would otherwise survive
    // normalisation as an opaque segment.
    let decoded: string;
    try {
      decoded = decodeURIComponent(relative);
    } catch {
      return undefined;
    }
    // A NUL truncates a path in some syscalls; nothing legitimate contains one.
    if (decoded.includes('\0')) return undefined;

    const candidate = resolve(join(this.#root, normalize(decoded)));
    if (candidate !== this.#root && !candidate.startsWith(`${this.#root}/`)) {
      return undefined;
    }
    return candidate;
  }

  /**
   * `cache-control` is the whole reason to serve a file rather than inline it.
   *
   * `immutable` is only honest for a **content-addressed** name - `ui.a1b2c3.js` -
   * where a change produces a different URL. For anything else it is a promise the
   * server cannot keep, so the default is a short max-age and the caller opts into
   * the long one per asset.
   */
  #cacheControl(pathname: string): string {
    const { immutable, maxAge } = this.#options;
    return immutable(pathname)
      ? 'public, max-age=31536000, immutable'
      : `public, max-age=${maxAge}`;
  }

  async handle(
    req: BunRequest,
    _ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    const { pathname } = new URL(req.url);
    if (pathname !== this.#options.path && !pathname.startsWith(this.#prefix)) {
      return next();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();

    const path = this.resolvePath(pathname);
    // A traversal attempt falls through rather than answering 403: the app's own
    // 404 is the correct answer to a path that does not exist, and a distinct
    // status would confirm the root's location.
    if (path === undefined) return next();

    const file = Bun.file(path);
    if (!(await file.exists())) return next();

    return new Response(file, {
      headers: {
        'cache-control': this.#cacheControl(pathname),
        // Bun sets content-type from the extension. Stated for anything it does
        // not know, rather than left to the browser to sniff.
        ...(file.type === ''
          ? { 'content-type': 'application/octet-stream' }
          : {}),
        'x-content-type-options': 'nosniff',
      },
    });
  }
}
