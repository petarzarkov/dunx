import { AppError } from '@dunx/core';
import { meta, UseGuards } from '../route/metadata.js';
import { IdempotencyGuard } from './guard.js';
import { IDEMPOTENT, type IdempotentRoute } from './options.js';

/**
 * Opts a handler, or every non-`GET` handler of a controller, into
 * `Idempotency-Key` handling. It is `@UseGuards(IdempotencyGuard)` plus the
 * route's options, so a route without it runs no idempotency code at all.
 *
 * A handler's own options win over its controller's, as `@Throttle`'s do.
 * Needs `IdempotencyModule` imported somewhere in the app.
 */
export const Idempotent = (route: IdempotentRoute = {}) => {
  const { ttlSeconds } = route;
  if (
    ttlSeconds !== undefined &&
    (!Number.isInteger(ttlSeconds) || ttlSeconds < 1)
  ) {
    throw new AppError(
      `@Idempotent() needs a ttlSeconds of at least 1; got ${ttlSeconds}.`,
    );
  }
  const mark = meta(IDEMPOTENT, route);
  const guard = UseGuards(IdempotencyGuard);
  return <F extends object>(target: F): F => guard(mark(target));
};
