import { HttpStatusCode } from '../server/status.js';
import { FetchError, FetchTransportError } from './errors.js';

/**
 * Retry, backoff and `Retry-After`, with no dependency.
 *
 * `crypto.getRandomValues` supplies the jitter. `Math.random` is what the source
 * this was ported from used and is banned repo-wide for anything that matters -
 * jitter matters, because decorrelating retries is the whole reason it exists. The
 * alternative, `@arkv/rng`, is a 64 KB WebAssembly PRNG, which is a lot of weight
 * to put in every deployment of the most-imported package to choose a number of
 * milliseconds. `crypto.getRandomValues` is a Web standard Bun implements natively,
 * is a CSPRNG, and costs nothing.
 */
const uniform = (): number => {
  const buffer = new Uint32Array(1);
  crypto.getRandomValues(buffer);
  // 2**32 rather than 0xffffffff, so the result is [0, 1) and never exactly 1.
  return (buffer[0] ?? 0) / 2 ** 32;
};

export interface BackoffOptions {
  /** Base delay, doubled each attempt. */
  readonly baseMs: number;
  /** @default 2 */
  readonly power?: number;
  /** Upper bound of the random component added to each delay. @default 1000 */
  readonly jitterMs?: number;
  /** @default 30000 */
  readonly maxMs?: number;
}

/** `base * power^attempt + jitter`, capped. `attempt` is 0 for the first retry. */
export const backoffDelay = (
  attempt: number,
  { baseMs, power = 2, jitterMs = 1000, maxMs = 30_000 }: BackoffOptions,
): number => Math.min(baseMs * power ** attempt + uniform() * jitterMs, maxMs);

/**
 * The wait an upstream asked for, in ms, or undefined.
 *
 * RFC 9110 allows either a delay in seconds or an HTTP date, and both appear in
 * the wild - GitHub sends seconds, some CDNs send a date. Ignoring the header, as
 * the reference did, means retrying straight back into a rate limit that had just
 * told you exactly how long to wait.
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
 * one that timed out. Deliberately narrower than the source, which also retried
 * 409 and 422 - both of those are the server rejecting the *request*, and sending
 * it again unchanged gets the same answer.
 */
export const isRetryableStatus = (status: number): boolean =>
  status >= HttpStatusCode.INTERNAL_SERVER_ERROR ||
  status === HttpStatusCode.REQUEST_TIMEOUT ||
  status === HttpStatusCode.TOO_MANY_REQUESTS;

export interface RetryOptions<T> {
  /** Retries *after* the first attempt, so 3 means up to 4 calls. @default 3 */
  readonly maxRetries?: number;
  /** @default 1000 */
  readonly retryDelayMs?: number;
  readonly backoff?: Omit<BackoffOptions, 'baseMs'>;
  /** @default isRetryableStatus */
  readonly shouldRetryOnStatus?: (status: number) => boolean;
  /** Honour a `Retry-After` header over the computed backoff. @default true */
  readonly respectRetryAfter?: boolean;
  readonly onAttempt?: (attempt: number, isRetry: boolean) => void;
  readonly onError?: (
    error: unknown,
    attempt: number,
    willRetry: boolean,
  ) => void;
  readonly onSuccess?: (result: T, attempt: number) => void;
}

/**
 * Whether an error is worth another attempt, and how long to wait first.
 *
 * An abort is never retried: the caller's signal fired or the timeout expired, and
 * both mean the budget for this call is spent. A transport failure is retried,
 * because a refused connection is the case retrying exists for.
 */
const decide = <T>(
  error: unknown,
  attempt: number,
  options: RetryOptions<T>,
): { readonly retry: boolean; readonly delayMs: number } => {
  const {
    retryDelayMs = 1000,
    backoff,
    shouldRetryOnStatus = isRetryableStatus,
    respectRetryAfter = true,
  } = options;
  const computed = backoffDelay(attempt, { baseMs: retryDelayMs, ...backoff });

  if (error instanceof FetchTransportError) {
    return { retry: !error.aborted, delayMs: computed };
  }

  if (error instanceof FetchError) {
    if (!shouldRetryOnStatus(error.status)) return { retry: false, delayMs: 0 };
    const asked = respectRetryAfter
      ? retryAfterMs(error.response.headers)
      : undefined;
    // Still capped by the backoff ceiling: an upstream asking for an hour should
    // not park a request handler for an hour.
    const maxMs = backoff?.maxMs ?? 30_000;
    return {
      retry: true,
      delayMs: asked === undefined ? computed : Math.min(asked, maxMs),
    };
  }

  // Something other than a fetch failure - a JSON parse, a callback throwing.
  // Retried, matching the source, because a non-HTTP error carries no verdict.
  return { retry: true, delayMs: computed };
};

/**
 * Runs `operation`, retrying per `options`.
 *
 * `Bun.sleep` rather than a `setTimeout` promise: it is the runtime's own timer and
 * needs no wrapper.
 */
export const executeWithRetry = async <T>(
  operation: () => Promise<T> | T,
  options: RetryOptions<T> = {},
): Promise<T> => {
  const { maxRetries = 3, onAttempt, onError, onSuccess } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    onAttempt?.(attempt + 1, attempt > 0);
    try {
      const result = await operation();
      onSuccess?.(result, attempt + 1);
      return result;
    } catch (error) {
      lastError = error;
      const { retry, delayMs } = decide(error, attempt, options);
      const willRetry = retry && attempt < maxRetries;
      onError?.(error, attempt + 1, willRetry);

      if (!willRetry) throw error;
      await Bun.sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws. Kept so the signature does not
  // need `T | undefined`.
  throw lastError;
};
