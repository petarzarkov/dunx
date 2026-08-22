import { Logger } from '@dunx/core';
import {
  FetchError,
  FetchTransportError,
  HttpService,
} from '@dunx/http/client';

/**
 * Calling out, over `fetch` and therefore over no dependency at all.
 *
 * Three things a bare `fetch` does not do: retry a 503 with backoff, raise a
 * non-2xx as an error carrying the parsed body, and forward the inbound request id
 * so one trace covers both services.
 */
export class UpstreamDemo {
  constructor(
    private readonly logger: Logger,
    private readonly http: HttpService,
  ) {}

  async demonstrate(url: string): Promise<void> {
    const notes = await this.http.get<readonly string[]>(
      new URL('api/notes', url),
    );
    this.logger.info(`GET api/notes -> ${JSON.stringify(notes)}`);

    // The 503s are retried; the attempt callback is what makes that visible.
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

    /**
     * A 404 is a `FetchError`, not an `HttpError`. That distinction is the whole
     * reason the class exists: an upstream 401 arriving as an `HttpError(401)`
     * would make *this* service answer 401, telling its own caller "you are
     * unauthorized" when what failed was this service authenticating upstream.
     */
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

    // Not retried: the budget for the call is spent, and an abort means the
    // caller's signal fired or the timeout did. `/slow` sleeps 300 ms, so this
    // is a deadline rather than a race with the loopback.
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
