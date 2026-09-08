import { Controller, Get } from '@dunx/http';
import { FetchError, HttpService } from '@dunx/http/client';
import { ApiDoc } from '@dunx/openapi';
import { FLAKY_FAILURES } from '../upstream/flaky.controller.js';
import { SelfOrigin } from './self-origin.js';

interface Attempt {
  readonly attempt: number;
  readonly retry: boolean;
  readonly atMs: number;
}

/** `@dunx/http/client` retrying a 503. Calling `/api/upstream/flaky` from
 * JavaScript would show a flaky upstream, not dunx retrying one, so this goes
 * through `HttpService` and hands back what `onAttempt` saw. */
@ApiDoc({
  tags: ['Demo'],
  description:
    'Calls the flaky upstream through HttpService and reports every attempt ' +
    'the retry policy made, with the delay between them.',
})
@Controller('demo')
export class RetryController {
  constructor(
    private readonly http: HttpService,
    private readonly origin: SelfOrigin,
  ) {}

  @Get('/retry')
  async retry(): Promise<{
    key: string;
    attempts: readonly Attempt[];
    elapsedMs: number;
    outcome: string;
  }> {
    // A fresh key per call, so the upstream fails its first two every time
    // rather than only for the first visitor after a deploy.
    const key = Math.random().toString(36).slice(2, 10);
    // Nothing the caller sent reaches this: `req.url`'s port made it a scanner.
    const target = new URL(
      `/api/upstream/flaky?key=${key}`,
      this.origin.require(),
    );

    const attempts: Attempt[] = [];
    const started = Bun.nanoseconds();
    const at = (): number =>
      Number(((Bun.nanoseconds() - started) / 1e6).toFixed(1));

    try {
      const recovered = await this.http.get<{ recovered: true; after: number }>(
        target,
        {
          retry: {
            // One more than the upstream owes, so there is a spare attempt.
            maxRetries: FLAKY_FAILURES + 1,
            retryDelayMs: 40,
            backoff: { jitterMs: 20, maxMs: 400 },
            onAttempt: (attempt, isRetry) =>
              attempts.push({ attempt, retry: isRetry, atMs: at() }),
          },
        },
      );
      return {
        key,
        attempts,
        elapsedMs: at(),
        outcome: `recovered after ${recovered.after} upstream calls`,
      };
    } catch (error) {
      const status = error instanceof FetchError ? error.status : 0;
      return {
        key,
        attempts,
        elapsedMs: at(),
        outcome: `gave up on ${status || 'transport failure'}`,
      };
    }
  }
}
