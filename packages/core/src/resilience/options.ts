import type { BackoffOptions } from './backoff.js';
import type { CircuitBreaker } from './breaker.js';
import type { Bulkhead } from './bulkhead.js';
import { RetryClassifier, TransientRetryClassifier } from './classifier.js';

export interface RetryOptions<T = unknown> {
  /** Retries *after* the first attempt, so 3 means up to 4 calls. @default 3 */
  readonly maxRetries?: number;
  /** @default 1000 */
  readonly retryDelayMs?: number;
  readonly backoff?: Omit<BackoffOptions, 'baseMs'>;
  readonly onAttempt?: (attempt: number, isRetry: boolean) => void;
  readonly onError?: (
    error: unknown,
    attempt: number,
    willRetry: boolean,
  ) => void;
  readonly onSuccess?: (result: T, attempt: number) => void;
}

export interface ResilienceOptionsInit {
  /**
   * Per attempt, enforced with `AbortSignal.timeout` and handed to the operation.
   * 0 leaves each attempt unbounded. @default 0
   */
  readonly timeoutMs?: number;
  readonly retry?: RetryOptions;
  /** @default TransientRetryClassifier */
  readonly classifier?: RetryClassifier;
  /**
   * Answers the call when every attempt failed, receiving the last error. It may
   * throw, which replaces the failure rather than suppressing it.
   */
  readonly fallback?: (error: unknown) => unknown;
  /**
   * Asked before every attempt and told how each one went. An instance, so one
   * breaker per dependency is shared by every policy calling it.
   */
  readonly breaker?: CircuitBreaker;
  /**
   * Held for the whole call, retries and backoff included, so `maxConcurrent`
   * counts calls rather than attempts. Shared the same way as `breaker`.
   */
  readonly bulkhead?: Bulkhead;
  /**
   * A caller's own cancellation, combined with each attempt's timeout. Per call
   * rather than per policy, so a policy carrying one is built per call:
   * `HttpService` does that, and a module-bound policy leaves it out.
   */
  readonly signal?: AbortSignal;
  /** Bound as its own token, so a second policy can be injected by name. */
  readonly name?: string;
}

/**
 * The resolved options, as a class so it is both the injection token and the type
 * a factory annotates, which is the trick `HttpClientOptions` and `ConfigService`
 * already use.
 */
export class ResilienceOptions {
  readonly timeoutMs: number;
  readonly retry: RetryOptions;
  readonly classifier: RetryClassifier;
  readonly fallback: ((error: unknown) => unknown) | undefined;
  readonly breaker: CircuitBreaker | undefined;
  readonly bulkhead: Bulkhead | undefined;
  readonly signal: AbortSignal | undefined;
  readonly name: string | undefined;

  constructor(init: ResilienceOptionsInit = {}) {
    this.timeoutMs = init.timeoutMs ?? 0;
    this.retry = init.retry ?? {};
    this.classifier = init.classifier ?? new TransientRetryClassifier();
    this.fallback = init.fallback;
    this.breaker = init.breaker;
    this.bulkhead = init.bulkhead;
    this.signal = init.signal;
    this.name = init.name;
  }
}
