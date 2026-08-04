/**
 * `@dunx/http/client` - the outbound half.
 *
 * A subpath rather than the root barrel: `HttpFactory` there is the inbound
 * direction, and `HttpModule` next to it would read as either. Importing
 * `@dunx/http` does not load any of this.
 */
export { FetchError, FetchTransportError } from './client/errors.js';
export { isJsonBody, isPlainObject, safeStringify } from './client/json.js';
export {
  DEFAULT_REQUEST_ID_HEADER,
  HttpClientOptions,
  type HttpClientOptionsInit,
} from './client/options.js';
export {
  backoffDelay,
  executeWithRetry,
  isRetryableStatus,
  retryAfterMs,
  type BackoffOptions,
  type RetryOptions,
} from './client/retry.js';
export { httpClient, HttpModule } from './client/module.js';
export {
  HttpService,
  type HeaderFactory,
  type RequestConfig,
  type RequestMethod,
} from './client/service.js';
