/**
 * `@dunx/http/client` - the outbound half.
 *
 * A subpath rather than the root barrel: `HttpFactory` there is the inbound
 * direction, and `HttpModule` next to it would read as either. Importing
 * `@dunx/http` does not load any of this.
 */
export { FetchError, FetchTransportError } from './client/errors.js';
export {
  HttpClientOptions,
  type HttpClientOptionsInit,
} from './client/options.js';
/**
 * Retry, backoff and jitter are `@dunx/core`'s, re-exported so an import of this
 * subpath still names them. What stays here is the HTTP half of the decision:
 * `HttpRetryClassifier` reads a status and a `Retry-After`, which is the seam that
 * keeps both out of core.
 */
export type { BackoffOptions, RetryOptions } from '@dunx/core';
export { HttpRetryClassifier, type HttpRetryOptions } from './client/retry.js';
export { httpClient, HttpModule, type ClientTarget } from './client/module.js';
export {
  HttpService,
  type HeaderFactory,
  type RequestConfig,
  type RequestMethod,
} from './client/service.js';
/** What `streamSseEvents` yields: one dispatched event, envelope included. */
export type { SseMessage } from './client/sse.js';
