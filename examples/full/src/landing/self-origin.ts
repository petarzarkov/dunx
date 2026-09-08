import { HttpError, HttpStatusCode } from '@dunx/http';

/**
 * The origin this process is reachable at, handed in once `listen()` resolved.
 *
 * Nothing else can tell `RetryController` where the app's own routes are:
 * `config.get('port')` is 0 under a suite, `req.url` is built from `Host`, and
 * the live server reaches `ClientAddress` privately with no post-`listen` hook.
 */
export class SelfOrigin {
  #origin: string | undefined;

  set(url: string): void {
    this.#origin = new URL(url).origin;
  }

  /** Unset is a 503, not a guess. Only a boot serving `/api/demo/retry` sets it. */
  require(): string {
    if (this.#origin === undefined) {
      throw new HttpError(
        HttpStatusCode.SERVICE_UNAVAILABLE,
        'SelfOrigin is unset - call set() with the url listen() returned',
      );
    }
    return this.#origin;
  }
}
