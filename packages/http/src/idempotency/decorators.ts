import { meta, UseGuards } from '../route/metadata.js';
import { IdempotencyGuard } from './guard.js';
import { IDEMPOTENT, positive, type IdempotentRoute } from './options.js';

/**
 * Opts a handler, or every non-`GET` handler of a controller, into
 * `Idempotency-Key` handling. It is `@UseGuards(IdempotencyGuard)` plus the
 * route's options, so a route without it runs no idempotency code at all.
 *
 * A handler's own options win over its controller's, as `@Throttle`'s do.
 * Needs `IdempotencyModule` imported somewhere in the app.
 */
export const Idempotent = (route: IdempotentRoute = {}) => {
  if (route.ttlSeconds !== undefined) {
    positive('ttlSeconds', route.ttlSeconds, '@Idempotent()');
  }
  const mark = meta(IDEMPOTENT, route);
  const guard = UseGuards(IdempotencyGuard);
  return <F extends object>(target: F): F => guard(mark(target));
};
