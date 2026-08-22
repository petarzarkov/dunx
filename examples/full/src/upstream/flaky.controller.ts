import {
  Controller,
  Get,
  HttpError,
  HttpStatusCode,
  SkipThrottle,
} from '@dunx/http';

/**
 * An upstream that fails before it works, so the retry has something to retry.
 *
 * Per process and per key, so the tour and a suite do not spend each other's
 * failures. `@SkipThrottle()` because a retry loop is exactly the traffic shape the
 * rate limit exists to refuse.
 */
@Controller('upstream')
@SkipThrottle()
export class FlakyController {
  readonly #failures = new Map<string, number>();

  /** 503 for the first two calls on a key, then 200. */
  @Get('/flaky')
  flaky(): { recovered: true; after: number } {
    const key = 'default';
    const seen = (this.#failures.get(key) ?? 0) + 1;
    this.#failures.set(key, seen);
    if (seen <= 2) {
      throw new HttpError(
        HttpStatusCode.SERVICE_UNAVAILABLE,
        `not ready yet (attempt ${seen})`,
      );
    }
    return { recovered: true, after: seen };
  }

  /** Slower than any budget the demo gives it, so the timeout is not a race. */
  @Get('/slow')
  async slow(): Promise<{ done: true }> {
    await Bun.sleep(300);
    return { done: true };
  }

  /** Never retried: a 404 is an answer, not a failure worth repeating. */
  @Get('/missing')
  missing(): never {
    throw new HttpError(HttpStatusCode.NOT_FOUND, 'no such upstream record');
  }
}
