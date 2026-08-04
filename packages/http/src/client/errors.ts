import { AppError } from '@dunx/core';

/**
 * Any non-2xx response from an outbound call, carrying the parsed body.
 *
 * **Deliberately not an `HttpError`.** `HttpError` is the inbound contract - the
 * default error mapper reads its `status` and answers the caller with it - so an
 * upstream 401 arriving as an `HttpError(401)` would make this service reply 401,
 * telling *its* client "you are unauthorized" when what actually happened is that
 * this service could not authenticate upstream. Extending `AppError` instead means
 * an unhandled upstream failure surfaces as a 500, which is the honest default, and
 * a caller who knows better maps it:
 *
 * ```ts
 * try {
 *   return await this.http.get(url);
 * } catch (error) {
 *   if (error instanceof FetchError && error.status === 404) return null;
 *   throw new HttpError(HttpStatusCode.BAD_GATEWAY, 'upstream unavailable');
 * }
 * ```
 */
export class FetchError extends AppError {
  override readonly name = 'FetchError';

  constructor(
    readonly status: number,
    readonly statusText: string,
    /** The response body, parsed as JSON when it was, else text, else undefined. */
    readonly body: unknown,
    readonly response: {
      readonly method: string;
      readonly url: string;
      readonly headers: Headers;
    },
  ) {
    super(
      `HTTP ${status} ${statusText} from ${response.method} ${response.url}`,
    );
  }
}

/**
 * The request never produced a response: DNS failure, connection refused, TLS
 * rejection, or the timeout firing. `fetch` reports these as a `TypeError` or an
 * `AbortError`, neither of which says which call died.
 *
 * Separate from {@link FetchError} because there is no status to branch on and the
 * retry decision is different: a transport failure is worth retrying by default,
 * while a 400 never is.
 */
export class FetchTransportError extends AppError {
  override readonly name = 'FetchTransportError';

  constructor(
    readonly response: { readonly method: string; readonly url: string },
    /** True when the timeout or the caller's signal aborted it. */
    readonly aborted: boolean,
    options?: ErrorOptions,
  ) {
    super(
      `${response.method} ${response.url} failed: ${
        aborted ? 'aborted' : 'transport error'
      }`,
      options,
    );
  }
}
