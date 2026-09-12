/**
 * What the framework calls on itself, and the only place it is exported from: the
 * discovery readers and route metadata `@dunx/dashboard`, `@dunx/mcp`,
 * `@dunx/openapi` and `@dunx/testing` import. The barrel stays the surface an app
 * writes against.
 *
 * It held 62 symbols and 50 had no importer, all reachable from inside this
 * package by relative import. Add one back when a sibling needs it. No stability
 * promise attaches here.
 */
export {
  discoverRoutes,
  joinPath,
  type DiscoveredRoute,
} from './route/discover.js';
export { RoutePrefix } from './route/prefix.js';
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
export { IMMUTABLE_CACHE_CONTROL } from './static/files.js';
export { embedJson } from './server/html.js';
export { isGateway } from './ws/marker.js';
