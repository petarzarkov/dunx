import { joinPath } from '@dunx/http';
import type { OpenApiDocument } from './types.js';

/**
 * Where the app actually mounted this controller. `setGlobalPrefix('api')` prefixes
 * every discovered route — including the document's own — so the request URL is the
 * evidence: declared at `/openapi.json`, answered at `/api/openapi.json`, therefore
 * every other route in the table moved by the same `/api`.
 *
 * That inference exists because the global prefix lives on the `HttpApp` and is not
 * readable from inside the container. Given `HttpApp.routes`, this would be the
 * paths themselves and the guess would be gone.
 */
export const mountPrefix = (pathname: string, declared: string): string => {
  if (pathname === declared || !pathname.endsWith(declared)) return '';
  return pathname.slice(0, pathname.length - declared.length);
};

/** The same `joinPath` the app used, so the document's paths match its table exactly. */
export const withPrefix = (
  document: OpenApiDocument,
  prefix: string,
): OpenApiDocument => ({
  ...document,
  paths: Object.fromEntries(
    Object.entries(document.paths).map(([path, item]) => [
      joinPath(prefix, path),
      item,
    ]),
  ),
});
