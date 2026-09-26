import type { BunRequest } from 'bun';
import type { DiscoveredRoute } from '../route/discover.js';
import type { RouteInput } from '../route/schema.js';
import type { ErrorMapper } from './errors.js';
import { conditionalGet, type EntityTags } from './etag.js';
import type { InputReader } from './input.js';
import type { RouteHandler, ServedHandler } from './middleware.js';
import type { SecuredResponses } from './security-headers.js';
import { HttpStatusCode } from './status.js';

/** What a route's responses are built with, when the app enabled either. */
export interface ResponseExtras {
  readonly tags?: EntityTags | undefined;
  readonly secured?: SecuredResponses | undefined;
}

/**
 * A `Response` passes through untouched - that is the escape hatch, and nothing
 * about it is worth second-guessing. Nothing at all is a 204: `Response.json(null)`
 * would be a body claiming to be no body.
 *
 * `tags` is set on a `GET` route under `etag`. A 200 value is then tagged, and a
 * handler's own `Response` only has its own `ETag` compared.
 */
export const toResponse = (
  value: unknown,
  status: number,
  req: Request,
  { tags, secured }: ResponseExtras,
): Response => {
  if (value instanceof Response) {
    return tags === undefined ? value : conditionalGet(value, req);
  }
  if (value === undefined || value === null) {
    return secured
      ? secured.empty(HttpStatusCode.NO_CONTENT)
      : new Response(null, { status: HttpStatusCode.NO_CONTENT });
  }
  if (tags !== undefined && status === HttpStatusCode.OK) {
    return tags.json(value, req);
  }
  return secured
    ? secured.json(value, status)
    : Response.json(value, { status });
};

/**
 * The direct path, taken when a route has no middleware. Nothing here
 * is `async`: a promise is allocated only where there is something to wait for.
 *
 * The general path is four `await`s across two async frames on values that are
 * usually not thenable. A route with no schemas awaits nothing, and a `body` route
 * pays one promise link instead of six frames.
 *
 * Worth ~6 points of throughput on `params` and a further ~5 on `validate`. A
 * handler that does return a promise is adopted rather than awaited by a wrapper.
 */
export const directOr = (
  guarded: RouteHandler,
  route: DiscoveredRoute,
  read: InputReader,
  status: number,
  onError: ErrorMapper,
  noMiddleware: boolean,
  extras: ResponseExtras,
): ServedHandler => {
  if (!noMiddleware) return guarded;

  // `toResponse` throws on a value `JSON.stringify` cannot take, so it is inside
  // the mapper's reach on every branch - including the `then` callbacks, where a
  // throw would otherwise escape as an unhandled rejection instead of a 500.
  const settle = (value: unknown, req: BunRequest): Response => {
    try {
      return toResponse(value, status, req, extras);
    } catch (error) {
      return onError(error, req);
    }
  };

  const invoke = (
    input: RouteInput,
    req: BunRequest,
  ): Response | Promise<Response> => {
    try {
      const value = route.handler(input);
      return value instanceof Promise
        ? value.then(
            (resolved) => settle(resolved, req),
            (error: unknown) => onError(error, req),
          )
        : settle(value, req);
    } catch (error) {
      return onError(error, req);
    }
  };

  return (req) => {
    try {
      const input = read(req);
      return input instanceof Promise
        ? input.then(
            (resolved) => invoke(resolved, req),
            (error: unknown) => onError(error, req),
          )
        : invoke(input, req);
    } catch (error) {
      return onError(error, req);
    }
  };
};
