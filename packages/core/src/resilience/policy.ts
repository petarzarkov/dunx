import { backoffDelay } from './backoff.js';
import type { ResilienceOptions } from './options.js';

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
    try {
      return await this.#attempts(op);
    } catch (error) {
      const { fallback } = this.options;
      if (fallback === undefined) throw error;
      // A policy is shared across operations of different result types, so its
      // fallback cannot be typed per call.
      return (await fallback(error)) as T;
    }
  }

  async #attempts<T>(op: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const {
      maxRetries = 3,
      onAttempt,
      onError,
      onSuccess,
    } = this.options.retry;

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
        if (!willRetry) throw error;
        // `Bun.sleep` rather than a `setTimeout` promise: it is the runtime's own
        // timer and needs no wrapper.
        await Bun.sleep(verdict.delayMs);
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
    const maxMs = backoff?.maxMs ?? 30_000;
    const asked = verdict.delayMs;
    return {
      retry: true,
      delayMs: asked === undefined ? computed : Math.min(asked, maxMs),
    };
  }

  #signal(): AbortSignal {
    const { timeoutMs, signal } = this.options;
    return AbortSignal.any([
      ...(timeoutMs > 0 ? [AbortSignal.timeout(timeoutMs)] : []),
      ...(signal === undefined ? [] : [signal]),
    ]);
  }
}
