import type { RetryOptions } from './retry.js';

/**
 * Named `HttpClientOptions`, not `HttpOptions`: the server half already exports
 * that from `@dunx/http` for `HttpFactory.create`, and two things called
 * `HttpOptions` meaning opposite directions of traffic is the confusion this
 * subpath exists to avoid.
 */
export interface HttpClientOptionsInit {
  /**
   * Prefixed to a relative `path`. With it, calls name a path; without it, every
   * call passes a whole url.
   */
  readonly baseUrl?: string | URL;
  /** Per-request budget, enforced with `AbortSignal.timeout`. @default 30000 */
  readonly timeoutMs?: number;
  /** Sent on every request, under anything a call sets itself. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly retry?: RetryOptions<unknown>;
  /**
   * Forward W3C Trace Context upstream as `traceparent`, so the callee's spans
   * join this request's trace and one trace spans both services.
   *
   * Read from `RequestContext`, so it only carries when a trace is in scope -
   * which the inbound side puts there unless `requestLogging: { trace: false }`
   * removed it. With that off there is nothing to send and this costs one
   * property read.
   *
   * The caller's `traceFlags` are sent as they arrived, so a trace an upstream
   * sampler declined is not re-sampled at this hop.
   *
   * @default true
   */
  readonly propagateTrace?: boolean;
  /** Bound as its own token, so a second client can be injected by name. */
  readonly name?: string;
  /**
   * Bun-only `fetch` extensions, passed straight through. None of these exist on
   * Node's fetch, and they are the reason an outbound client on Bun can do things a
   * ported one cannot: talk through a proxy, pin a certificate, or reach a unix
   * socket, with no dependency.
   */
  /**
   * The object form carries `Proxy-Authorization` to the proxy rather than to the
   * target, which the string form cannot express.
   */
  readonly proxy?: BunFetchRequestInit['proxy'];
  readonly tls?: Bun.TLSOptions;
  readonly unix?: string;
  /** @default true - Bun decompresses by default. */
  readonly decompress?: boolean;
  /** Bun's own request/response tracing on stderr. Never on in production. */
  readonly verbose?: boolean;
  /**
   * Compress the request body. A string names the encoding; the object form sets
   * the level too.
   */
  readonly compress?: BunFetchRequestInit['compress'];
  /**
   * `'http2'` lets concurrent requests to one origin share a connection, which is
   * what a service calling a single upstream in a loop wants.
   */
  readonly protocol?: BunFetchRequestInit['protocol'];
  /** How many redirects to follow before rejecting. */
  readonly maxRedirects?: number;
}

/**
 * The resolved options, as a class so it is both the injection token and the type
 * a factory annotates - the same trick `RedisOptions` and `ConfigService` use.
 */
export class HttpClientOptions {
  readonly baseUrl: string | undefined;
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly retry: RetryOptions<unknown>;
  readonly propagateTrace: boolean;
  readonly name: string | undefined;
  readonly fetchOptions: Readonly<Record<string, unknown>>;

  constructor(init: HttpClientOptionsInit = {}) {
    this.baseUrl =
      init.baseUrl === undefined ? undefined : String(init.baseUrl);
    this.timeoutMs = init.timeoutMs ?? 30_000;
    this.headers = init.headers ?? {};
    this.retry = init.retry ?? {};
    this.name = init.name;
    this.propagateTrace = init.propagateTrace ?? true;

    // Only the keys actually set: `exactOptionalPropertyTypes` means passing
    // `proxy: undefined` is not the same as omitting it, and Bun reads presence.
    this.fetchOptions = Object.fromEntries(
      (
        [
          ['proxy', init.proxy],
          ['tls', init.tls],
          ['unix', init.unix],
          ['decompress', init.decompress],
          ['verbose', init.verbose],
          ['compress', init.compress],
          ['protocol', init.protocol],
          ['maxRedirects', init.maxRedirects],
        ] as const
      ).filter(([, value]) => value !== undefined),
    );
  }
}
