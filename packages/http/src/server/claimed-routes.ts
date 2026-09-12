/**
 * The paths a path-claiming middleware serves off the unmatched fallback.
 *
 * `ThrottleGuard` skips unmatched paths so a burst of 404s cannot spend a real
 * caller's budget. A claimed path is not a 404: something answers it, and it
 * costs whatever that costs, so it is rate limited like any route.
 *
 * Attached by `listen()`, for the reason `RoutePrefix` is: the set is not known
 * until every middleware has been resolved.
 */
export class ClaimedRoutes {
  #paths: ReadonlySet<string> = new Set();

  attach(paths: Iterable<string>): void {
    this.#paths = new Set(paths);
  }

  has(path: string): boolean {
    return this.#paths.has(path);
  }
}
