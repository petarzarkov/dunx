import {
  RetryClassifier,
  type RetryOptions,
  type RetryVerdict,
} from '@dunx/core';
import { HttpStatusCode } from '../server/status.js';
import { FetchError, FetchTransportError } from './errors.js';

/**
 * The wait an upstream asked for, in ms, or undefined.
 *
 * RFC 9110 allows either a delay in seconds or an HTTP date, and both appear in
 * the wild: GitHub sends seconds, some CDNs send a date. Ignoring the header means
 * retrying straight back into a rate limit that had just said how long to wait.
 */
export const retryAfterMs = (
  headers: Headers,
  now: number = Date.now(),
): number | undefined => {
  const header = headers.get('retry-after');
  if (header === null) return undefined;

  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
};

/**
 * Statuses worth trying again: a server that failed, one that is overloaded, and
 * one that timed out. Narrower than 409 and 422, which are the server rejecting
 * the *request* - sending it again unchanged gets the same answer.
 */
export const isRetryableStatus = (status: number): boolean =>
  status >= HttpStatusCode.INTERNAL_SERVER_ERROR ||
  status === HttpStatusCode.REQUEST_TIMEOUT ||
  status === HttpStatusCode.TOO_MANY_REQUESTS;

/** Core's generic retry knobs plus the two an HTTP failure carries. */
export interface HttpRetryOptions<T = unknown> extends RetryOptions<T> {
  /** @default isRetryableStatus */
  readonly shouldRetryOnStatus?: (status: number) => boolean;
  /** Honour a `Retry-After` header over the computed backoff. @default true */
  readonly respectRetryAfter?: boolean;
}

/**
 * The HTTP half of the retry decision, and the only place in dunx's resilience
 * path that knows what a status is.
 *
 * An abort is never retried: the caller's signal fired or the timeout expired, and
 * both mean the budget for this call is spent. A transport failure is retried,
 * because a refused connection is the case retrying exists for.
 */
export class HttpRetryClassifier extends RetryClassifier {
  constructor(private readonly options: HttpRetryOptions = {}) {
    super();
  }

  classify(error: unknown): RetryVerdict {
    if (error instanceof FetchTransportError) return { retry: !error.aborted };

    if (error instanceof FetchError) {
      const {
        shouldRetryOnStatus = isRetryableStatus,
        respectRetryAfter = true,
      } = this.options;
      if (!shouldRetryOnStatus(error.status)) return { retry: false };

      const asked = respectRetryAfter
        ? retryAfterMs(error.response.headers)
        : undefined;
      return asked === undefined
        ? { retry: true }
        : { retry: true, delayMs: asked };
    }

    // Something other than a fetch failure: a JSON parse, a callback throwing.
    // Retried, because a non-HTTP error carries no verdict.
    return { retry: true };
  }
}
