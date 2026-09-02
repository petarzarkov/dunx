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
export type { BackoffOptions, RetryOptions } from './client/retry.js';
export { httpClient, HttpModule } from './client/module.js';
export {
  HttpService,
  type HeaderFactory,
  type RequestConfig,
  type RequestMethod,
} from './client/service.js';
