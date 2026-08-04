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
   * Forward the inbound request id to the upstream, so one trace spans both
   * services. `true` uses `x-request-id`; a string names the header. Read from
   * `RequestContext`, so it only carries when there is a request in scope.
   *
   * @default true
   */
  readonly propagateRequestId?: boolean | string;
  /** Bound as its own token, so a second client can be injected by name. */
  readonly name?: string;
  /**
   * Bun-only `fetch` extensions, passed straight through. None of these exist on
   * Node's fetch, and they are the reason an outbound client on Bun can do things a
   * ported one cannot: talk through a proxy, pin a certificate, or reach a unix
   * socket, with no dependency.
   */
  readonly proxy?: string;
  readonly tls?: Bun.TLSOptions;
  readonly unix?: string;
  /** @default true - Bun decompresses by default. */
  readonly decompress?: boolean;
  /** Bun's own request/response tracing on stderr. Never on in production. */
  readonly verbose?: boolean;
}

export const DEFAULT_REQUEST_ID_HEADER = 'x-request-id';

/**
 * The resolved options, as a class so it is both the injection token and the type
 * a factory annotates - the same trick `RedisOptions` and `ConfigService` use.
 */
export class HttpClientOptions {
  readonly baseUrl: string | undefined;
  readonly timeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly retry: RetryOptions<unknown>;
  readonly requestIdHeader: string | undefined;
  readonly name: string | undefined;
  readonly fetchOptions: Readonly<Record<string, unknown>>;

  constructor(init: HttpClientOptionsInit = {}) {
    this.baseUrl =
      init.baseUrl === undefined ? undefined : String(init.baseUrl);
    this.timeoutMs = init.timeoutMs ?? 30_000;
    this.headers = init.headers ?? {};
    this.retry = init.retry ?? {};
    this.name = init.name;

    const propagate = init.propagateRequestId ?? true;
    this.requestIdHeader =
      propagate === false
        ? undefined
        : propagate === true
          ? DEFAULT_REQUEST_ID_HEADER
          : propagate;

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
        ] as const
      ).filter(([, value]) => value !== undefined),
    );
  }
}
