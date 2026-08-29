import { HttpService } from '@dunx/http/client';

/**
 * A second outbound client, with its own timeout, reachable as a constructor
 * parameter: `httpClient('health')` returns a `Token`, and a token can only be
 * reached with `inject()` in a field. `upstream.module.ts` binds it with
 * `HttpClientModule.forRootAsync(config, HealthClient)`.
 */
export class HealthClient extends HttpService {}
