import { HttpService } from '@dunx/http/client';

/**
 * A second outbound client, with its own timeout, reachable as a constructor
 * parameter.
 *
 * `httpClient('health')` returns a `Token`, and a token is not a class - so a
 * consumer had to write `readonly health = inject(httpClient('health'))` in a
 * field. A subclass is both a token and a parameter type, so it resolves the same
 * way any other service does. `HttpModule.forRootAsync(config, HealthClient)` in
 * `upstream.module.ts` is what binds it.
 */
export class HealthClient extends HttpService {}
