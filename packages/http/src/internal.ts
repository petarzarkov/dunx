/**
 * What the framework calls on itself. Every symbol here is still reachable from
 * the package barrel, deprecated, and leaves it in 4.0.
 *
 * The barrel is a semver promise, and 173 of them was more than this package
 * meant to make. What stays public is the surface an app writes against:
 * decorators, options, contracts, errors, modules and the metadata helpers a
 * user's own guard reads. What is here is route-table construction, the
 * middleware fold, the relay codec and the discovery readers - things
 * `@dunx/dashboard`, `@dunx/mcp` and `@dunx/openapi` need and an app does not.
 *
 * No stability promise attaches to this subpath.
 */
export {
  discoverRoutes,
  joinPath,
  type DiscoveredRoute,
} from './route/discover.js';
export {
  defaultStatusFor,
  type DefaultStatus,
  type RouteMeta,
} from './route/marker.js';
export { guardsOf } from './route/metadata.js';
export {
  gatewaysOf,
  routesOf,
  type GatewayHandler,
  type GatewayNode,
  type RouteInputs,
  type RouteNode,
} from './inspect.js';
export { buildContext } from './server/context.js';
export { preflight, withCors } from './server/cors.js';
export { isErrorFilter, toErrorMapper } from './server/errors.js';
export { compose } from './server/middleware.js';
export {
  assertNoCollisions,
  assertNoGatewayCollisions,
  buildRoutes,
  withUpgradeRoutes,
  type BunRoutes,
  type GuardResolver,
  type RouteMethod,
  type ServeRoutes,
} from './server/routes.js';
export { normalizePrefix } from './static/options.js';
export { negotiate } from './compression/negotiate.js';
export { isCompressibleType } from './compression/options.js';
export {
  buildWebSocket,
  type UpgradeHandler,
  type WebSocketRuntime,
} from './ws/adapter.js';
export {
  discoverGateway,
  discoverGateways,
  normalizePath,
  type DiscoveredGateway,
  type DiscoveredHandler,
  type Invoke,
} from './ws/discover.js';
export { decode, encode } from './ws/envelope.js';
export { composeSocket, observe } from './ws/middleware.js';
export { HandlerKind, isGateway, type HandlerMeta } from './ws/marker.js';
export { defaultRelayUrl } from './ws/redis-relay.js';
export {
  decodeRelay,
  encodeRelay,
  type RelayFrame,
  type RelayPhase,
} from './ws/relay.js';
export {
  buildGateways,
  buildRuntime,
  type GatewayRuntime,
} from './ws/runtime.js';
export { HiddenHealthController } from './health/controller.js';
export {
  backoffDelay,
  executeWithRetry,
  isRetryableStatus,
  retryAfterMs,
} from './client/retry.js';
export { isJsonBody, isPlainObject, safeStringify } from './client/json.js';
