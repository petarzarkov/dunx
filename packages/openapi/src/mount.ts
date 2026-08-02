import { joinPath } from '@dunx/http';
import type { OpenApiDocument } from './types.js';

/**
 * Where the app actually mounted this controller. `setGlobalPrefix('api')` prefixes
 * every discovered route - including the document's own - so the request URL is the
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

/**
 * The same `joinPath` the app used, so the document's paths match its table exactly.
 *
 * `absolute` names the paths a contributor supplied. Those describe endpoints
 * dunx does not route - Better Auth serves its own - so they do not move when
 * `setGlobalPrefix()` moves the controllers, and prefixing them produced
 * `/api/api/auth/sign-in` with nothing warning about it.
 */
export const withPrefix = (
  document: OpenApiDocument,
  prefix: string,
  absolute: ReadonlySet<string> = new Set(),
): OpenApiDocument => ({
  ...document,
  paths: Object.fromEntries(
    Object.entries(document.paths).map(([path, item]) => [
      absolute.has(path) ? path : joinPath(prefix, path),
      item,
    ]),
  ),
});
