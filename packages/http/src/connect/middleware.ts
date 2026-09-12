import type { BunRequest } from 'bun';
import { UNMATCHED } from '../route/metadata.js';
import type { RouteContext } from '../server/context.js';
import type { Middleware, Next } from '../server/middleware.js';
import { HttpStatusCode } from '../server/status.js';
import { ConnectRegistry } from './registry.js';

/** `application/grpc`, with or without a `+proto` suffix. `application/grpc-web`
 * is a different media type and does not match. */
const NATIVE_GRPC = /^application\/grpc(?:$|\+)/;

const isNativeGrpc = (contentType: string | null): boolean =>
  contentType !== null &&
  NATIVE_GRPC.test(contentType.split(';')[0]?.trim().toLowerCase() ?? '');

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
 * a guard and the throttle apply to a call as they apply to a route. Register it
 * with `app.use`, since position in the chain decides what covers it.
 *
 * RPC paths are in no route table, so they reach the `fetch` fallback, where
 * `ctx.get(UNMATCHED)` is true and `ctx.path` is already parsed. Reading it
 * first is what leaves a matched route paying nothing. Anything outside the
 * registered paths falls through untouched.
 */
export class ConnectMiddleware implements Middleware {
  readonly #registry: ConnectRegistry;

  constructor(registry: ConnectRegistry) {
    this.#registry = registry;
  }

  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    if (ctx.get(UNMATCHED) !== true) return next();

    const handler = this.#registry.handlerFor(ctx.path);
    if (handler === undefined) return next();

    if (isNativeGrpc(req.headers.get('content-type'))) {
      return Promise.resolve(grpcUnsupported());
    }
    return handler(req);
  }
}
