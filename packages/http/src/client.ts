/**
 * `@dunx/http/client` - the outbound half.
 *
 * A subpath rather than the root barrel: `HttpFactory` there is the inbound
 * direction, and `HttpModule` next to it would read as either. Importing
 * `@dunx/http` does not load any of this.
 */
export { FetchError, FetchTransportError } from './client/errors.js';
export {
  DEFAULT_REQUEST_ID_HEADER,
  HttpClientOptions,
  type HttpClientOptionsInit,
} from './client/options.js';
export type { BackoffOptions, RetryOptions } from './client/retry.js';
export { httpClient, HttpModule } from './client/module.js';
export {
  HttpService,
  type HeaderFactory,
  type RequestConfig,
  type RequestMethod,
} from './client/service.js';

/**
 * The client's own plumbing, still reachable here and moving out in 3.0.
 * Import it from `@dunx/http/internal`, which carries no stability promise.
 *
 * @deprecated Import from `@dunx/http/internal`. Removed in 3.0.
 */
export {
  backoffDelay,
  executeWithRetry,
  isJsonBody,
  isPlainObject,
  isRetryableStatus,
  retryAfterMs,
  safeStringify,
} from './internal.js';
