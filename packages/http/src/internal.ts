/**
 * What the framework calls on itself, and the only place it is exported from.
 *
 * The barrel was a semver promise 173 symbols wide, which is more than this
 * package meant to make. What stays public there is the surface an app writes
 * against. What is here is the discovery readers and route metadata that
 * `@dunx/dashboard`, `@dunx/mcp`, `@dunx/openapi` and `@dunx/testing` import.
 *
 * It held 62 symbols and 50 had no importer, all of them reachable from inside
 * this package by relative import. Add one back when a sibling needs it.
 *
 * No stability promise attaches to this subpath.
 */
export {
  discoverRoutes,
  joinPath,
  type DiscoveredRoute,
} from './route/discover.js';
export { defaultStatusFor } from './route/marker.js';
export {
  gatewaysOf,
  routesOf,
  type GatewayHandler,
  type GatewayNode,
  type RouteInputs,
  type RouteNode,
} from './inspect.js';
export { buildContext } from './server/context.js';
export { isGateway } from './ws/marker.js';
