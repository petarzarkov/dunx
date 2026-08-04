import { Logger, RequestContext } from '@dunx/core';
import { UrlHelper, type ParamsType } from '@arkv/shared';
import type { HttpMethod } from '../route/marker.js';
import { FetchError, FetchTransportError } from './errors.js';
import { isJsonBody, safeStringify } from './json.js';
import { HttpClientOptions } from './options.js';
import { executeWithRetry, type RetryOptions } from './retry.js';

/** The client speaks two more verbs than a route can declare. */
export type RequestMethod = HttpMethod | 'HEAD' | 'OPTIONS';

/**
 * `@arkv/shared`'s own param type, imported rather than restated - a local copy
 * would drift from what `buildUrl` actually accepts, which is how `null` ended up
 * in the first draft of this file and `interpolate` would never have seen it.
 */
type Params = ParamsType;

/**
 * `fetch`'s own body type, derived from its signature. `BodyInit` is not a global
 * here: the root tsconfig sets `lib: ["ESNext"]` with no DOM, so the name does not
 * exist even though the value does. Reading it off `typeof fetch` needs no lib and
 * cannot disagree with the runtime.
 */
type FetchBody = NonNullable<NonNullable<Parameters<typeof fetch>[1]>['body']>;

export type HeaderFactory = (params: {
  /** Unix seconds, which is what every HMAC scheme signs. */
  readonly timestamp: number;
  readonly method: RequestMethod;
  /** `pathname + search`, the part such schemes sign. */
  readonly requestPath: string;
  /** The serialised body, or `''`. */
  readonly body: string;
}) => Record<string, string>;

export interface RequestConfig<TRequest = unknown, TResponse = unknown> {
  readonly method: RequestMethod;
  /** Absolute, or relative to `baseUrl`. Omit when `baseUrl` plus `path` is enough. */
  readonly url?: string | URL;
  readonly payload?: TRequest;
  readonly headers?: Readonly<Record<string, string>>;
  /** Appended to the base, with `{param}` interpolated from `pathParams`. */
  readonly path?: string;
  readonly pathParams?: Params;
  readonly queryParams?: Params;
  /** Overrides the client's default budget. */
  readonly timeoutMs?: number;
  /** Called once per attempt, so a signature covers the body it is sent with. */
  readonly headerFactory?: HeaderFactory;
  /** Merged into the async context for this call, so its logs carry it. */
  readonly flow?: string;
  readonly retry?: RetryOptions<TResponse>;
  /** Cancels the call. Combined with the timeout, whichever fires first. */
  readonly signal?: AbortSignal;
}

type BaseOptions<TRequest, TResponse> = Omit<
  RequestConfig<TRequest, TResponse>,
  'method' | 'url' | 'payload'
>;

/**
 * What `send` reads. Narrower than `RequestConfig` on purpose: `RetryOptions<T>` is
 * invariant in `T` - its `onSuccess` takes a `T` and its callbacks return one - so a
 * `RequestConfig<_, TResponse>` is not assignable to a `RequestConfig<_, unknown>`.
 * `send` never touches `retry`, so leaving it out is both true and assignable.
 */
interface SendConfig {
  readonly method: RequestMethod;
  readonly headers?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly headerFactory?: HeaderFactory;
  readonly signal?: AbortSignal;
}

/**
 * A `fetch` client with a per-request timeout, retry with backoff, request-id
 * propagation and one log line per call.
 *
 * `fetch` and nothing else: it is a Web standard Bun implements natively, so there
 * is no client dependency to justify - which is also why `axios` and `node-fetch`
 * are banned repo-wide. What this adds over calling `fetch` yourself is the parts
 * every caller otherwise reimplements slightly differently: the timeout, the
 * retry policy, `Retry-After`, url building, and a failure that says which call
 * failed.
 *
 * Extends `UrlHelper` from `@arkv/shared`, so `buildUrl` and `interpolate` are
 * available on the service, and there is one implementation of them across the
 * owner's projects rather than a fork per repo.
 */
export class HttpService extends UrlHelper {
  constructor(
    private readonly options: HttpClientOptions,
    private readonly logger: Logger,
    private readonly requestContext: RequestContext,
  ) {
    super();
  }

  async request<TRequest = unknown, TResponse = unknown>(
    config: RequestConfig<TRequest, TResponse>,
  ): Promise<TResponse> {
    const url = this.urlFor(config);
    const startedAt = Date.now();
    let attempts = 0;
    let status: number | undefined;

    /**
     * Serialised **once**, outside the retry loop. A body does not change between
     * attempts - only the signature over it does, and `headerFactory` gets a fresh
     * timestamp per attempt from `send`.
     *
     * Doing it inside meant a caller's own `JSON.stringify` failure, a circular
     * payload, was treated as a retryable error: three attempts and eight seconds of
     * backoff before surfacing a bug that no amount of retrying could fix. It also
     * re-serialised a large body on every attempt.
     */
    const { body, serialised } = this.bodyFor(config.payload);

    /**
     * A stream body is consumed by the first attempt, so a second would send an
     * empty one. Retrying is switched off rather than left to fail as a confusing
     * "body already used" on the retry.
     */
    const replayable = !(config.payload instanceof ReadableStream);

    const attempt = async (): Promise<TResponse> => {
      attempts += 1;
      const response = await this.send(config, url, body, serialised);
      status = response.status;

      if (!response.ok) {
        throw new FetchError(
          response.status,
          response.statusText,
          await readBody(response),
          {
            method: config.method,
            url: url.href,
            headers: response.headers,
          },
        );
      }

      return (await readBody(response)) as TResponse;
    };

    const describe = (): string => `${config.method} ${url.href}`;

    try {
      const result = await this.requestContext.runWithContext(
        {
          ...(config.flow === undefined ? {} : { flow: config.flow }),
          event: config.path ?? url.pathname,
        },
        () =>
          executeWithRetry(attempt, {
            ...this.options.retry,
            ...config.retry,
            ...(replayable ? {} : { maxRetries: 0 }),
          } as RetryOptions<TResponse>),
      );

      this.logger.debug(`${describe()} succeeded`, {
        status,
        attempts,
        elapsedMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      this.logger.error(`${describe()} failed`, {
        // `safeStringify`, not the error object: an upstream body can carry a cycle
        // and this is the one place that must not throw while reporting a throw.
        err: safeStringify(describeError(error)),
        attempts,
        elapsedMs: Date.now() - startedAt,
      });
      throw error;
    }
  }

  get<TResponse = unknown>(
    url?: string | URL,
    options?: BaseOptions<never, TResponse>,
  ): Promise<TResponse> {
    return this.request<never, TResponse>({
      method: 'GET',
      ...options,
      ...urlOf(url),
    });
  }

  post<TRequest = unknown, TResponse = unknown>(
    url?: string | URL,
    payload?: TRequest,
    options?: BaseOptions<TRequest, TResponse>,
  ): Promise<TResponse> {
    return this.request<TRequest, TResponse>({
      method: 'POST',
      ...options,
      ...urlOf(url),
      ...(payload === undefined ? {} : { payload }),
    });
  }

  put<TRequest = unknown, TResponse = unknown>(
    url?: string | URL,
    payload?: TRequest,
    options?: BaseOptions<TRequest, TResponse>,
  ): Promise<TResponse> {
    return this.request<TRequest, TResponse>({
      method: 'PUT',
      ...options,
      ...urlOf(url),
      ...(payload === undefined ? {} : { payload }),
    });
  }

  patch<TRequest = unknown, TResponse = unknown>(
    url?: string | URL,
    payload?: TRequest,
    options?: BaseOptions<TRequest, TResponse>,
  ): Promise<TResponse> {
    return this.request<TRequest, TResponse>({
      method: 'PATCH',
      ...options,
      ...urlOf(url),
      ...(payload === undefined ? {} : { payload }),
    });
  }

  delete<TResponse = unknown>(
    url?: string | URL,
    options?: BaseOptions<never, TResponse>,
  ): Promise<TResponse> {
    return this.request<never, TResponse>({
      method: 'DELETE',
      ...options,
      ...urlOf(url),
    });
  }

  /**
   * Yields each `data:` payload of a Server-Sent-Events response, consuming the
   * terminating `[DONE]` sentinel rather than yielding it.
   *
   * **No retry**, deliberately: a partially consumed stream cannot be replayed, so
   * retrying would re-deliver events the caller has already seen. The timeout
   * covers the connect only - it is dropped once headers arrive, or a long-lived
   * stream would be cut off mid-flight.
   *
   * Hand-rolled rather than delegated: Bun exposes no `EventSource` global and no
   * SSE parser, which was measured rather than assumed.
   */
  async *streamSse<TRequest = unknown>(
    config: Omit<RequestConfig<TRequest>, 'method' | 'retry'> & {
      readonly method?: 'GET' | 'POST';
    },
  ): AsyncGenerator<string> {
    const url = this.urlFor(config);
    const method = config.method ?? 'POST';
    const startedAt = Date.now();
    const { body, serialised } = this.bodyFor(config.payload);

    const response = await this.send(
      { ...config, method },
      url,
      body,
      serialised,
      'text/event-stream',
    );

    if (!response.ok || response.body === null) {
      throw new FetchError(
        response.status,
        response.statusText,
        await readBody(response),
        { method, url: url.href, headers: response.headers },
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');

          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') return;
          yield data;
        }
      }
    } finally {
      reader.releaseLock();
      this.logger.debug(`SSE ${method} ${url.href} closed`, {
        elapsedMs: Date.now() - startedAt,
      });
    }
  }

  /**
   * Resolves the target, accepting the three forms a caller actually reaches for:
   * an absolute url, a path relative to `baseUrl`, or `baseUrl` plus an explicit
   * `path`.
   *
   * `get('/users')` is the one worth calling out. A relative first argument is what
   * every HTTP client takes once a base url exists, and passing it straight to
   * `buildUrl` throws `ERR_INVALID_URL` from inside `new URL()` - a message naming
   * neither the call nor the missing base. So a first argument that is not an
   * absolute url is treated as the path, which is what it reads as.
   *
   * `URL.canParse` decides, rather than a regex over `//` or `:` - it is the same
   * parser `new URL` uses, so the two cannot disagree.
   */
  private urlFor(config: {
    readonly url?: string | URL;
    readonly path?: string;
    readonly pathParams?: Params;
    readonly queryParams?: Params;
  }): URL {
    const given = config.url === undefined ? undefined : String(config.url);
    const absolute =
      given !== undefined && given !== '' && URL.canParse(given)
        ? given
        : undefined;
    const relative = given === '' || absolute !== undefined ? undefined : given;
    const base = absolute ?? this.options.baseUrl;

    if (base === undefined) {
      throw new FetchTransportError(
        { method: 'GET', url: given ?? config.path ?? '(none)' },
        false,
        {
          cause: new Error(
            'No url to call. Pass an absolute url, or set baseUrl on ' +
              'HttpModule.forRoot and pass a path.',
          ),
        },
      );
    }

    // An explicit `path` wins over a relative first argument, so a call cannot
    // silently request two different paths.
    const path = config.path ?? relative;

    return this.buildUrl({
      base,
      ...(path === undefined ? {} : { path }),
      ...(config.pathParams === undefined
        ? {}
        : { pathParams: config.pathParams }),
      ...(config.queryParams === undefined
        ? {}
        : { queryParams: config.queryParams }),
    });
  }

  /** `serialised` is what a `headerFactory` signs, and is `''` for no body. */
  private bodyFor(payload: unknown): {
    body: FetchBody | undefined;
    serialised: string;
    json: boolean;
  } {
    if (payload === undefined || payload === null) {
      return { body: undefined, serialised: '', json: false };
    }
    if (!isJsonBody(payload)) {
      return { body: payload as FetchBody, serialised: '', json: false };
    }
    // Plain `JSON.stringify`, deliberately not `safeStringify`: a cycle here must
    // throw rather than be sent upstream as "[Circular]".
    const serialised = JSON.stringify(payload);
    return { body: serialised, serialised, json: true };
  }

  private async send(
    config: SendConfig,
    url: URL,
    body: FetchBody | undefined,
    serialised: string,
    accept = 'application/json',
  ): Promise<Response> {
    const requestId =
      this.options.requestIdHeader === undefined
        ? undefined
        : this.requestContext.getContext().requestId;

    const headers: Record<string, string> = {
      accept,
      ...(serialised === '' ? {} : { 'content-type': 'application/json' }),
      ...this.options.headers,
      ...(requestId === undefined || this.options.requestIdHeader === undefined
        ? {}
        : { [this.options.requestIdHeader]: requestId }),
      ...config.headerFactory?.({
        timestamp: Math.floor(Date.now() / 1000),
        method: config.method,
        requestPath: url.pathname + url.search,
        body: serialised,
      }),
      ...config.headers,
    };

    /**
     * `AbortSignal.timeout` plus `AbortSignal.any`, rather than an
     * `AbortController` with a `setTimeout` and a `clearTimeout` in a `finally`.
     * Both are Web standards Bun implements, the timer is the runtime's to cancel,
     * and combining the caller's signal with the budget is one call instead of a
     * second listener that has to be removed.
     */
    const timeoutMs = config.timeoutMs ?? this.options.timeoutMs;
    const signals = [
      ...(timeoutMs > 0 ? [AbortSignal.timeout(timeoutMs)] : []),
      ...(config.signal === undefined ? [] : [config.signal]),
    ];

    try {
      return await fetch(url.href, {
        method: config.method,
        headers,
        ...(body === undefined ? {} : { body }),
        ...(signals.length === 0 ? {} : { signal: AbortSignal.any(signals) }),
        ...this.options.fetchOptions,
      });
    } catch (error) {
      // `fetch` reports a refused connection, a DNS failure and an abort all as
      // exceptions with nothing naming the call. Wrapped so the message does.
      const aborted =
        error instanceof Error &&
        (error.name === 'AbortError' || error.name === 'TimeoutError');
      throw new FetchTransportError(
        { method: config.method, url: url.href },
        aborted,
        { cause: error },
      );
    }
  }
}

const urlOf = (url?: string | URL): { url?: string | URL } =>
  url === undefined ? {} : { url };

/** JSON when the upstream said so or the body parses; text otherwise; undefined for empty. */
const readBody = async (response: Response): Promise<unknown> => {
  const text = await response.text().catch(() => '');
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const describeError = (error: unknown): Record<string, unknown> => {
  if (error instanceof FetchError) {
    return {
      name: error.name,
      message: error.message,
      status: error.status,
      body: error.body,
    };
  }
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
};
