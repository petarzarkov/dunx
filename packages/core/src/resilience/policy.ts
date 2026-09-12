import { backoffDelay, DEFAULT_MAX_DELAY_MS } from './backoff.js';
import type { ResilienceOptions } from './options.js';

/**
 * Handed to an attempt that has neither a budget nor a caller's signal. One for
 * the process: nothing holds the controller, so it can never abort and there is
 * nothing to observe per attempt.
 */
const unbounded = new AbortController().signal;

/**
 * Timeout, retry, backoff, jitter and fallback around one operation.
 *
 * There is no circuit breaker and no bulkhead here, and no rate limiter: inbound
 * admission control is `ThrottleModule` in `@dunx/http`, and retrying work this
 * process owns is bullmq's through `@dunx/infra/queue`.
 */
export class ResiliencePolicy {
  constructor(private readonly options: ResilienceOptions) {}

  /**
   * Runs `op`, retrying per the policy, and answers with `fallback` when every
   * attempt failed.
   *
   * `op` receives the signal for its attempt: `AbortSignal.timeout` combined with
   * the caller's through `AbortSignal.any`, rather than a `setTimeout` and a
   * `clearTimeout` in a `finally`. Both are Web standards Bun implements, and the
   * timer is the runtime's to cancel.
   */
  async run<T>(op: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.#attempts(op);
  }

  /**
   * **Only `op`'s own rejection is caught.** The `try` holds the call and nothing
   * else, so a throw from `onAttempt`, `onSuccess`, `onError`, the classifier or
   * the sleep propagates as itself.
   *
   * Both halves of that were wrong and both were reachable. `onSuccess` used to
   * sit inside the `try`, so a throwing success hook was classified as a failed
   * attempt and **ran `op` again**: measured at four calls for one succeeding
   * operation, which for a charge is four charges. And `fallback` used to wrap
   * this whole method, so a throw from `onAttempt` returned the fallback value
   * for an operation that had never run.
   */
  async #attempts<T>(op: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const {
      maxRetries = 3,
      onAttempt,
      onError,
      onSuccess,
    } = this.options.retry;
    const { fallback } = this.options;

    // No terminating condition: every path out is a return or a throw, so a
    // counted loop would end on a line no test can reach.
    for (let attempt = 0; ; attempt += 1) {
      onAttempt?.(attempt + 1, attempt > 0);
      try {
        const result = await op(this.#signal());
        onSuccess?.(result, attempt + 1);
        return result;
      } catch (error) {
        const verdict = this.#decide(error, attempt);
        const willRetry = verdict.retry && attempt < maxRetries;
        onError?.(error, attempt + 1, willRetry);
        if (willRetry) {
          // `Bun.sleep` rather than a `setTimeout` promise: it is the runtime's
          // own timer and needs no wrapper.
          await Bun.sleep(verdict.delayMs);
          continue;
        }
        if (fallback === undefined) throw error;
        // A policy is shared across operations of different result types, so its
        // fallback cannot be typed per call.
        return (await fallback(error)) as T;
      }
    }
  }

  #decide(
    error: unknown,
    attempt: number,
  ): { readonly retry: boolean; readonly delayMs: number } {
    const { retryDelayMs = 1000, backoff } = this.options.retry;
    const verdict = this.options.classifier.classify(error);
    if (!verdict.retry) return { retry: false, delayMs: 0 };

    const computed = backoffDelay(attempt, {
      baseMs: retryDelayMs,
      ...backoff,
    });
    // An upstream asking for an hour should not park a request handler for an
    // hour, so what the failure asked for is still capped by the ceiling.
    const maxMs = backoff?.maxMs ?? DEFAULT_MAX_DELAY_MS;
    const asked = verdict.delayMs;
    return {
      retry: true,
      delayMs: asked === undefined ? computed : Math.min(asked, maxMs),
    };
  }

  // `AbortSignal.any` only where there are two signals to combine: an attempt with
  // one of them, or neither, gets that one or the process-wide `unbounded`.
  #signal(): AbortSignal {
    const { timeoutMs, signal } = this.options;
    if (timeoutMs <= 0) return signal ?? unbounded;
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal === undefined ? timeout : AbortSignal.any([timeout, signal]);
  }
}
