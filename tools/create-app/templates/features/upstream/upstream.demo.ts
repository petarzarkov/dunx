import { Logger } from '@dunx/core';
import {
  FetchError,
  FetchTransportError,
  HttpService,
} from '@dunx/http/client';
import { HealthClient } from './health.client.js';

/**
 * Calling out over `fetch`. Three things a bare `fetch` does not do: retry a 503
 * with backoff, raise a non-2xx as an error carrying the parsed body, and forward
 * the inbound request id.
 */
export class UpstreamDemo {
  constructor(
    private readonly logger: Logger,
    private readonly http: HttpService,
    // A named client as a constructor parameter, which is what registering it as
    // a subclass buys: `inject(httpClient('health'))` in a field is the only way
    // to reach one bound to a `Token`.
    private readonly health: HealthClient,
  ) {}

  async demonstrate(url: string): Promise<void> {
    const notes = await this.http.get<readonly string[]>(
      new URL('api/notes', url),
    );
    this.logger.info(`GET api/notes -> ${JSON.stringify(notes)}`);

    const live = await this.health.get<{ status: string }>(
      new URL('api/health/live', url),
    );
    this.logger.info(`HealthClient -> ${live.status}`);

    const attempts: string[] = [];
    const recovered = await this.http.get<{ after: number }>(
      new URL('api/upstream/flaky', url),
      {
        retry: {
          maxRetries: 3,
          retryDelayMs: 20,
          onAttempt: (attempt, isRetry) =>
            attempts.push(`${attempt}${isRetry ? ' (retry)' : ''}`),
        },
      },
    );
    this.logger.info(
      `two 503s then a 200 -> attempts ${attempts.join(', ')}, ` +
        `recovered after ${recovered.after}`,
    );

    /** A 404 is a `FetchError`, not an `HttpError`: an upstream 401 arriving as
     * `HttpError(401)` would make this service answer 401 to its own caller. */
    try {
      await this.http.get(new URL('api/upstream/missing', url), {
        retry: { maxRetries: 0 },
      });
    } catch (error) {
      if (!(error instanceof FetchError)) throw error;
      this.logger.info(
        `404 -> FetchError status ${error.status}, body ` +
          `${JSON.stringify(error.body)} (an AppError, so it surfaces as a 500 ` +
          'rather than passing the upstream status through)',
      );
    }

    // Not retried: an abort means the caller's signal or the timeout fired.
    try {
      await this.http.get(new URL('api/upstream/slow', url), {
        timeoutMs: 25,
        retry: { maxRetries: 0 },
      });
      throw new Error(
        'the 25 ms budget should not have covered a 300 ms route',
      );
    } catch (error) {
      if (!(error instanceof FetchTransportError)) throw error;
      this.logger.info(
        `timeoutMs: 25 against a 300 ms route -> ${error.name} ` +
          '(an abort is never retried)',
      );
    }
  }
}
