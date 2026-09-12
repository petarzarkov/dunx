import type { BunRequest } from 'bun';
import { REQUEST_SERVER, UNMATCHED } from '../route/metadata.js';
import type { RouteContext } from '../server/context.js';
import type { ClaimsPaths, Middleware, Next } from '../server/middleware.js';
import { HttpStatusCode } from '../server/status.js';
import { ConnectRegistry } from './registry.js';

/**
 * `application/grpc`, optionally `+proto` and any parameters, matched against the
 * raw header: anchored and case-insensitive, so it costs no split, trim or
 * lowercase on the path every routed Connect call takes. `application/grpc-web`
 * is a different media type and does not match.
 */
const NATIVE_GRPC = /^\s*application\/grpc\s*(?:[;+]|$)/i;

/** What a bare 415 does not say. */
const grpcUnsupported = (): Response =>
  Response.json(
    {
      code: 'unimplemented',
      message:
        'This endpoint serves Connect and gRPC-Web, not gRPC. gRPC carries ' +
        'grpc-status in an HTTP trailer and Bun.serve sends no trailers, so a ' +
        'gRPC client would read every call as a protocol error. Use a Connect ' +
        'or gRPC-Web transport, or put a proxy in front that translates.',
    },
    { status: HttpStatusCode.UNSUPPORTED_MEDIA_TYPE },
  );

/**
 * Serves every registered RPC as ordinary middleware, so request logging, CORS,
 * a guard and the dashboard apply to a call as they apply to a route. Register
 * it with `app.use`, since position in the chain decides what covers it.
 *
 * RPC paths are in no route table, so they reach the `fetch` fallback, where
 * `ctx.get(UNMATCHED)` is true and `ctx.path` is already parsed. Reading it
 * first is what leaves a matched route paying nothing. Anything outside the
 * registered paths falls through untouched.
 *
 * `ThrottleGuard` covers an RPC. Its early return is for an unmatched path
 * nobody claims, so a burst of 404s cannot spend a caller's budget; a claimed
 * path is served and is limited like a route. See docs/guide/27-rpc.md.
 */
export class ConnectMiddleware implements Middleware, ClaimsPaths {
  readonly #registry: ConnectRegistry;

  constructor(registry: ConnectRegistry) {
    this.#registry = registry;
  }

  /** Every mounted RPC path, so a controller cannot shadow one unnoticed. */
  claimedPaths(): readonly string[] {
    return this.#registry.paths;
  }

  /** Connect and gRPC-Web both POST. Connect's GET form is not served here. */
  claimedMethods(): readonly string[] {
    return ['POST'];
  }

  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    if (ctx.get(UNMATCHED) !== true) return next();

    const route = this.#registry.routeFor(ctx.path);
    if (route === undefined) return next();

    const contentType = req.headers.get('content-type');
    if (contentType !== null && NATIVE_GRPC.test(contentType)) {
      return Promise.resolve(grpcUnsupported());
    }

    // A streaming RPC may pause between messages for longer than `idleTimeout`
    // allows, and Bun severs it mid-stream. The unmatched context carries the
    // server that took this call, so the deadline is cleared on the right one.
    if (route.streaming) {
      ctx.get(REQUEST_SERVER)?.timeout(req, this.#registry.streamTimeout);
    }
    return route.handle(req);
  }
}
