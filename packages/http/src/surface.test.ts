import { describe, expect, it } from 'bun:test';

/**
 * The supported surface, frozen. `@dunx/http` had grown to 173 barrel exports,
 * every one of them a semver promise, and about a third were the framework's own
 * plumbing. Those live in `@dunx/http/internal` now.
 *
 * Freezing the list is what makes an addition show up in a diff, the same way
 * `site.test.tsx` freezes the published documentation set.
 */
const supported = (text: string): readonly string[] => {
  return [
    ...new Set(
      [...text.matchAll(/^export (?:type )?\{([^}]*)\}/gms)]
        .flatMap((match) => (match[1] ?? '').split(','))
        .map((name) => name.trim().replace(/^type /, ''))
        .filter(Boolean),
    ),
  ].sort();
};

const BARREL = [
  'ApiHidden',
  'AppSettings',
  'ClientAddress',
  'Compression',
  'CompressionEncoding',
  'CompressionModule',
  'CompressionOptions',
  'CompressionOptionsInit',
  'Controller',
  'CorsOptions',
  'CorsOrigin',
  'DEFAULT_RELAY_CHANNEL',
  'DatabaseIndicator',
  'DefaultHttpOptions',
  'Delete',
  'DiskIndicator',
  'DiskOptions',
  'DiskOptionsInit',
  'Envelope',
  'ErrorFilter',
  'ErrorHandler',
  'ErrorMapper',
  'Gateway',
  'Get',
  'HEALTH_REPORT_SCHEMA',
  'HIDDEN',
  'HealthCheckReport',
  'HealthController',
  'HealthIndicator',
  'HealthModule',
  'HealthOptions',
  'HealthOptionsInit',
  'HealthRegistry',
  'HealthReport',
  'HttpApp',
  'HttpError',
  'HttpErrorOptions',
  'HttpFactory',
  'HttpMethod',
  'HttpOptions',
  'HttpOptionsProvider',
  'HttpStatusCode',
  'HttpStatusName',
  'InferOutput',
  'Input',
  'InputSource',
  'JsonSchema',
  'MemoryIndicator',
  'MemoryOptions',
  'MemoryOptionsInit',
  'MemoryThrottleStore',
  'MetaKey',
  'MetaRecord',
  'Middleware',
  'Next',
  'OnClose',
  'OnDrain',
  'OnMessage',
  'OnOpen',
  'OnPing',
  'OnPong',
  'OnUpgrade',
  'PUBLIC',
  'Patch',
  'PingProbe',
  'Post',
  'ProbeResult',
  'ProbeState',
  'PubSub',
  'PubSubRelay',
  'Public',
  'Put',
  'QueryProbe',
  'REQUEST_ID_HEADER',
  'ROLES',
  'Readiness',
  'ReadinessOptions',
  'RedisIndicator',
  'RedisRelay',
  'RedisRelayOptions',
  'RedisThrottleStore',
  'RelayOptions',
  'RequestLoggingMiddleware',
  'RequestLoggingOptions',
  'ResponseMap',
  'Returns',
  'Roles',
  'RouteContext',
  'RouteHandler',
  'RouteInput',
  'RoutePath',
  'RouteSchemas',
  'SKIP_THROTTLE',
  'SkipThrottle',
  'Socket',
  'SocketContext',
  'SocketData',
  'SocketDispatch',
  'SocketErrorHandler',
  'SocketFrame',
  'SocketLoggingMiddleware',
  'SocketLoggingOptions',
  'SocketMiddleware',
  'SocketNext',
  'SocketOptions',
  'StandardSchemaIssue',
  'StandardSchemaResult',
  'StandardSchemaV1',
  'StaticFiles',
  'StaticModule',
  'StaticOptions',
  'StaticOptionsInit',
  'THROTTLE',
  'TRACEPARENT_HEADER',
  'TRACESTATE_HEADER',
  'Throttle',
  'ThrottleGuard',
  'ThrottleLimit',
  'ThrottleModule',
  'ThrottleOptions',
  'ThrottleOptionsInit',
  'ThrottleRedis',
  'ThrottleStore',
  'Trace',
  'TraceContext',
  'UNMATCHED',
  'UseGuards',
  'ValidationError',
  'ValidationIssue',
  'defaultErrorMapper',
  'errorMapper',
  'mergeMeta',
  'meta',
  'metaKey',
  'metaOf',
].sort();

const CLIENT = [
  'BackoffOptions',
  'DEFAULT_REQUEST_ID_HEADER',
  'FetchError',
  'FetchTransportError',
  'HeaderFactory',
  'HttpClientOptions',
  'HttpClientOptionsInit',
  'HttpModule',
  'HttpService',
  'RequestConfig',
  'RequestMethod',
  'RetryOptions',
  'httpClient',
].sort();

describe('public surface', () => {
  it('exports exactly the supported set from the barrel', async () => {
    const text = await Bun.file(
      new URL('./index.ts', import.meta.url).pathname,
    ).text();
    expect(supported(text)).toEqual(BARREL);
  });

  it('exports exactly the supported set from ./client', async () => {
    const text = await Bun.file(
      new URL('./client.ts', import.meta.url).pathname,
    ).text();
    expect(supported(text)).toEqual(CLIENT);
  });

  it('keeps the plumbing out of both supported sets', async () => {
    const internal = await Bun.file(
      new URL('./internal.ts', import.meta.url).pathname,
    ).text();
    const both = new Set([...BARREL, ...CLIENT]);

    for (const name of supported(internal)) {
      expect({ name, supported: both.has(name) }).toEqual({
        name,
        supported: false,
      });
    }
  });
});
