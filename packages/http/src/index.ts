export {
  Controller,
  Delete,
  Get,
  Patch,
  Post,
  Put,
} from './route/decorators.js';
export type { HttpMethod, RoutePath } from './route/marker.js';
// Route metadata and scoped middleware. `meta`/`metaKey` are the whole mechanism;
// `@Roles` and `@Public` are wrappers over it, and ROLES/PUBLIC are exported so a
// user's own guard can read what they set.
export {
  ApiHidden,
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
  JsonSchema,
  ResponseMap,
  Returns,
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
export { ClientAddress } from './server/client-address.js';
export type { RouteContext } from './server/context.js';
export type { CorsOptions, CorsOrigin } from './server/cors.js';
export {
  defaultErrorMapper,
  ErrorFilter,
  errorMapper,
  HttpError,
  ValidationError,
  type ErrorHandler,
  type ErrorMapper,
  type HttpErrorOptions,
  type InputSource,
  type ValidationIssue,
} from './server/errors.js';
export {
  HttpFactory,
  type HttpApp,
  type HttpOptions,
} from './server/factory.js';
// W3C Trace Context, on unless `requestLogging: { trace: false }` removes it.
// One header parsed and two written - no exporter, no sampler, no dependency.
// What it buys is that `traceId` on a log line here is the same `traceId` the
// service upstream logged, which is the part a collector cannot supply.
export {
  TRACEPARENT_HEADER,
  TRACERESPONSE_HEADER,
  TRACESTATE_HEADER,
  TraceContext,
  type Trace,
} from './server/trace-context.js';
export {
  RequestLoggingMiddleware,
  type RequestLoggingOptions,
} from './server/request-logging.js';
// Per-route counts and timings, on `node:perf_hooks`'s native histogram through
// `@dunx/core`'s `Durations`. Off unless `metrics: true`; the observation folds
// into the `.then` request logging already allocates. dunx serves the numbers as
// JSON and writes no Prometheus text - `prom-client` owns exposition, and its
// histogram is 61x the native one.
export {
  MetricsMiddleware,
  RequestMetrics,
  UNMATCHED_ROUTE,
  type HttpStatsReport,
  type RouteStats,
} from './server/metrics.js';
export type { Middleware, Next, RouteHandler } from './server/middleware.js';
export type { AppSettings } from './server/settings.js';
// Static files, on `Bun.file` - which already streams, sets content-type, answers
// a Range request and does it with sendfile(2). What is here is the traversal
// check and the cache policy, which is all Nest's `serve-static` adds that Bun
// does not already do. Registered by the app with `app.use(StaticFiles)`, never
// by the module: position in the chain is the app's decision.
export { StaticFiles } from './static/files.js';
export { StaticModule } from './static/module.js';
export { StaticOptions, type StaticOptionsInit } from './static/options.js';
// Response compression, on `Bun.zstdCompressSync`/`gzipSync` for a known length and
// `CompressionStream` for a stream. Not installed by default and not installed by
// the module either: the app calls `app.use(Compression)`, so an app that does not
// want it has no branch to skip. Brotli is not offered - Bun encodes it at 6,344 us
// against gzip's 23 for the same body, and ignores the `level` that would fix that.
export { Compression } from './compression/compression.js';
export { CompressionModule } from './compression/module.js';
export {
  CompressionEncoding,
  CompressionOptions,
  type CompressionOptionsInit,
} from './compression/options.js';
// A fixed-window rate limit. Here rather than in `@dunx/infra` because it is a
// `Middleware` reading a `MetaKey` off a `RouteContext`, and `@dunx/infra` must not
// depend on the web layer - the same boundary that made `@dunx/auth` its own
// package. `RedisThrottleStore` takes its client structurally, so this costs the
// package no dependency, exactly as `RedisRelay` does.
export {
  SKIP_THROTTLE,
  SkipThrottle,
  THROTTLE,
  Throttle,
  type ThrottleLimit,
} from './throttle/decorators.js';
export { ThrottleGuard } from './throttle/guard.js';
export { ThrottleModule } from './throttle/module.js';
export {
  ThrottleOptions,
  type ThrottleOptionsInit,
} from './throttle/options.js';
export {
  MemoryThrottleStore,
  RedisThrottleStore,
  ThrottleStore,
  type ThrottleRedis,
} from './throttle/store.js';
// One name, both meanings - the value for `HttpStatusCode.NOT_FOUND`, the type for
// annotations. Exactly what an enum gives, without the enum.
export { HttpStatusCode, type HttpStatusName } from './server/status.js';
// The websocket half: gateways are declared in @Module({ providers }) and served by
// the same Bun.serve call as the routes above.
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
export type { Envelope } from './ws/envelope.js';
// The socket half of the middleware chain. One interface with one method wrapping
// `next()`, the same shape the HTTP `Middleware` has - and `SocketLoggingMiddleware`
// is its `RequestLoggingMiddleware`, at `debug` because a gateway can take a frame
// per connection per tick.
export type {
  SocketContext,
  SocketDispatch,
  SocketFrame,
  SocketMiddleware,
  SocketNext,
} from './ws/middleware.js';
export {
  SocketLoggingMiddleware,
  type SocketLoggingOptions,
} from './ws/logging.js';
// `isGateway` is the filter that pairs with `discoverGateway` when walking a
// module's providers, exported for the same reason `guardsOf` and `metaOf` are: a
// reader outside this package needs the same channel the runtime uses.
export { PubSub } from './ws/pubsub.js';
// Multi-node fan-out. `PubSubRelay` is two methods, so `@dunx/infra`'s
// RedisConnection satisfies it structurally; `RedisRelay` is Bun.RedisClient
// directly and therefore costs this package no dependency.
export { RedisRelay, type RedisRelayOptions } from './ws/redis-relay.js';
export {
  DEFAULT_RELAY_CHANNEL,
  type PubSubRelay,
  type RelayOptions,
} from './ws/relay.js';
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
export { HEALTH_REPORT_SCHEMA } from './health/report-schema.js';
export { Readiness, ReadinessOptions } from './health/readiness.js';
export {
  HealthOptions,
  HealthRegistry,
  type HealthCheckReport,
  type HealthOptionsInit,
  type HealthReport,
} from './health/registry.js';
