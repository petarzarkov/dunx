import { joinPath } from './discover.js';

/**
 * The global prefix, as `listen()` resolved it.
 *
 * Bound by `HttpFactory`'s global wrapper next to `ClientAddress`, and attached
 * the same way: a second instance reads an empty prefix, which is a plausible
 * answer and a wrong one. Routes only, never gateways.
 * See docs/architecture/http.md, "Who knows the global prefix".
 */
export class RoutePrefix {
  #value = '';

  /** Empty when the app set none. */
  get value(): string {
    return this.#value;
  }

  attach(prefix: string): void {
    this.#value = prefix;
  }

  /** Where a discovered route is served. The one place that answers it. */
  apply(path: string): string {
    return this.#value === '' ? path : joinPath(this.#value, path);
  }
}
