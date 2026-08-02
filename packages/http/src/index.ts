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
  guardsOf,
  meta,
  metaKey,
  metaOf,
  mergeMeta,
  Public,
  PUBLIC,
  Roles,
  ROLES,
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
  errorMapper,
  HttpError,
  ValidationError,
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
export {
  discoverGateway,
  discoverGateways,
  normalizePath,
  type DiscoveredGateway,
  type DiscoveredHandler,
  type Invoke,
} from './ws/discover.js';
export { decode, encode, type Envelope } from './ws/envelope.js';
export { HandlerKind, type HandlerMeta } from './ws/marker.js';
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
