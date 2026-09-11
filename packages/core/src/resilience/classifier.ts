import { AppError } from '../di/errors.js';

export interface RetryVerdict {
  readonly retry: boolean;
  /**
   * A wait the failure itself asked for, in ms, used instead of the computed
   * backoff. Still capped by `backoff.maxMs`.
   */
  readonly delayMs?: number;
}

/**
 * Whether a failed attempt is worth another. An `abstract class` rather than an
 * interface, since an interface at an injection site is a boot error.
 *
 * It is also the seam that keeps HTTP out of this package: `HttpRetryClassifier`
 * in `@dunx/http/client` reads statuses and `Retry-After`, and core reads neither.
 */
export abstract class RetryClassifier {
  constructor() {
    if (new.target === RetryClassifier) {
      throw new AppError(
        'RetryClassifier is a contract, not an implementation. Pass one as ' +
          'ResilienceModule.forRoot({ classifier }), or leave it out for the ' +
          'TransientRetryClassifier.',
      );
    }
  }

  abstract classify(error: unknown): RetryVerdict;
}

/**
 * The default: every failure is worth another attempt except an abort.
 *
 * An abort means the attempt's timeout expired or the caller's signal fired, and
 * both spend the budget for the whole call. `AbortSignal.timeout` rejects with a
 * `TimeoutError` and `AbortController.abort()` with an `AbortError`, so the name
 * is what says which.
 */
export class TransientRetryClassifier extends RetryClassifier {
  classify(error: unknown): RetryVerdict {
    const aborted =
      error instanceof Error &&
      (error.name === 'AbortError' || error.name === 'TimeoutError');
    return { retry: !aborted };
  }
}
