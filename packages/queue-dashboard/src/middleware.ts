import { inject } from '@dunx/core';
import type { Middleware, Next, RouteContext } from '@dunx/http';
import type { BunRequest } from 'bun';
import { QUEUE_DASHBOARD, type QueueDashboard } from './module.js';

/**
 * Serves the dashboard, and passes everything else through.
 *
 * Global middleware rather than a controller, because bull-board's route table is
 * data it hands over at runtime - a dozen express-style paths with parameters - and
 * declaring those as dunx routes would mean generating controllers. Global
 * middleware also runs in front of the unmatched-path fallback, which is exactly
 * where the board's paths land, since the app declares none of them.
 *
 * `inject()` in a field initialiser rather than a constructor parameter: the
 * dashboard is bound to a `Token`, and a token is not a constructor type.
 */
export class QueueDashboardMiddleware implements Middleware {
  readonly #dashboard: QueueDashboard = inject(QUEUE_DASHBOARD);

  async handle(
    req: BunRequest,
    _ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    return (await this.#dashboard.handle(req)) ?? next();
  }
}
