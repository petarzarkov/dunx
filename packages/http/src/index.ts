export {
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Put,
} from './route/decorators.js';
export {
  discoverRoutes,
  joinPath,
  type DiscoveredRoute,
} from './route/discover.js';
export type { HttpMethod, RouteMeta, RoutePath } from './route/marker.js';
// Route metadata and scoped middleware. `meta`/`metaKey` are the whole mechanism;
// `@Roles` and `@Public` are wrappers over it, and ROLES/PUBLIC are exported so a
// user's own guard can read what they set.
export {
  ApiHidden,
  guardsOf,
  HIDDEN,
  meta,
  metaKey,
  metaOf,
  mergeMeta,
  Public,
  PUBLIC,
  Roles,
  ROLES,
  UNMATCHED,
  UseGuards,
  type MetaKey,
  type MetaRecord,
} from './route/metadata.js';
// The route input types. `Input<typeof opts>` is the handler annotation;
// StandardSchemaV1 is the validation contract, restated so Zod 4 / Valibot /
// ArkType all work with zero dependencies here.
export type {
  InferOutput,
  Input,
  RouteInput,
  RouteSchemas,
  StandardSchemaIssue,
  StandardSchemaResult,
  StandardSchemaV1,
} from './route/schema.js';
// The route and gateway readers. `@dunx/core` owns the container half of the same
// traversal (`providersOf`, `modulesOf`); this is the half that needs route
// metadata and the gateway marker. Both were `@dunx/mcp`'s until `@dunx/dashboard`
// became a second consumer.
export {
  gatewaysOf,
  routesOf,
  type GatewayHandler,
  type GatewayNode,
  type RouteInputs,
  type RouteNode,
} from './inspect.js';
export { ClientAddress } from './server/client-address.js';
export { buildContext, type RouteContext } from './server/context.js';
export {
  preflight,
  withCors,
  type CorsOptions,
  type CorsOrigin,
} from './server/cors.js';
export {
  defaultErrorMapper,
  ErrorFilter,
  errorMapper,
  HttpError,
  isErrorFilter,
  toErrorMapper,
  ValidationError,
  type ErrorHandler,
  type ErrorMapper,
  type InputSource,
  type ValidationIssue,
} from './server/errors.js';
export {
  HttpFactory,
  type HttpApp,
  type HttpOptions,
} from './server/factory.js';
export {
  REQUEST_ID_HEADER,
  RequestLoggingMiddleware,
  type RequestLoggingOptions,
} from './server/request-logging.js';
export {
  compose,
  type Middleware,
  type Next,
  type RouteHandler,
} from './server/middleware.js';
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
export type { AppSettings } from './server/settings.js';
// Static files, on `Bun.file` - which already streams, sets content-type, answers
// a Range request and does it with sendfile(2). What is here is the traversal
// check and the cache policy, which is all Nest's `serve-static` adds that Bun
// does not already do. Registered by the app with `app.use(StaticFiles)`, never
// by the module: position in the chain is the app's decision.
export { StaticFiles } from './static/files.js';
export { StaticModule } from './static/module.js';
export {
  normalizePrefix,
  StaticOptions,
  type StaticOptionsInit,
} from './static/options.js';
// One name, both meanings - the value for `HttpStatusCode.NOT_FOUND`, the type for
// annotations. Exactly what an enum gives, without the enum.
export { HttpStatusCode, type HttpStatusName } from './server/status.js';
// The websocket half: gateways are declared in @Module({ providers }) and served by
// the same Bun.serve call as the routes above.
export {
  buildWebSocket,
  type UpgradeHandler,
  type WebSocketRuntime,
} from './ws/adapter.js';
export {
  Gateway,
  OnClose,
  OnDrain,
  OnMessage,
  OnOpen,
  OnPing,
  OnPong,
  OnUpgrade,
} from './ws/decorators.js';
// `discoverGateways` resolves every gateway through the container; `discoverGateway`
// takes one instance, and `Object.create(Gateway.prototype)` satisfies it - which is
// how a reader inspects gateways without booting the app.
export {
  discoverGateway,
  discoverGateways,
  normalizePath,
  type DiscoveredGateway,
  type DiscoveredHandler,
  type Invoke,
} from './ws/discover.js';
export { decode, encode, type Envelope } from './ws/envelope.js';
// `isGateway` is the filter that pairs with `discoverGateway` when walking a
// module's providers, exported for the same reason `guardsOf` and `metaOf` are: a
// reader outside this package needs the same channel the runtime uses.
export { HandlerKind, isGateway, type HandlerMeta } from './ws/marker.js';
export { PubSub } from './ws/pubsub.js';
// Multi-node fan-out. `PubSubRelay` is two methods, so `@dunx/infra`'s
// RedisConnection satisfies it structurally; `RedisRelay` is Bun.RedisClient
// directly and therefore costs this package no dependency.
export {
  defaultRelayUrl,
  RedisRelay,
  type RedisRelayOptions,
} from './ws/redis-relay.js';
export {
  decodeRelay,
  DEFAULT_RELAY_CHANNEL,
  encodeRelay,
  type PubSubRelay,
  type RelayFrame,
  type RelayOptions,
  type RelayPhase,
} from './ws/relay.js';
export {
  buildGateways,
  buildRuntime,
  type GatewayRuntime,
} from './ws/runtime.js';
export type {
  Socket,
  SocketData,
  SocketErrorHandler,
  SocketOptions,
} from './ws/socket.js';
export {
  HealthIndicator,
  PingProbe,
  QueryProbe,
  type ProbeResult,
  type ProbeState,
} from './health/contracts.js';
export { HealthController } from './health/controller.js';
export {
  DatabaseIndicator,
  DiskIndicator,
  DiskOptions,
  MemoryIndicator,
  MemoryOptions,
  RedisIndicator,
  type DiskOptionsInit,
  type MemoryOptionsInit,
} from './health/indicators.js';
export { HealthModule } from './health/module.js';
export { Readiness, ReadinessOptions } from './health/readiness.js';
export {
  HealthOptions,
  HealthRegistry,
  type HealthCheckReport,
  type HealthOptionsInit,
  type HealthReport,
} from './health/registry.js';
