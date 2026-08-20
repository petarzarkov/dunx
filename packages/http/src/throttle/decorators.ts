import { meta, metaKey, type MetaKey } from '../route/metadata.js';

export interface ThrottleLimit {
  /** Requests allowed per window, per subject. */
  readonly limit: number;
  readonly windowSeconds: number;
}

/**
 * Read off a `RouteContext` the way `ROLES` and `PUBLIC` are, so an app can build
 * its own guard on the same metadata rather than a parallel one.
 */
export const THROTTLE: MetaKey<ThrottleLimit> = metaKey('throttle');
export const SKIP_THROTTLE: MetaKey<boolean> = metaKey('skip-throttle');

/**
 * A per-route limit, replacing the module's default for this handler.
 *
 * Valid on a method or on a class. A class-level limit covers every handler in the
 * controller and a handler's own wins over it, because the route's metadata is
 * `mergeMeta(klass, handler)` - the same precedence `@Roles` has.
 */
export const Throttle = (limit: ThrottleLimit) => meta(THROTTLE, limit);

/** Exempts a handler, or a whole controller, from the limit entirely. */
export const SkipThrottle = () => meta(SKIP_THROTTLE, true);
