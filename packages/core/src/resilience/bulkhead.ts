import { AppError } from '../di/errors.js';

export interface BulkheadOptions {
  /** Calls allowed to run at once. */
  readonly maxConcurrent: number;
  /**
   * Calls allowed to wait for a slot once every one is taken, beyond which a
   * call is rejected. 0 rejects as soon as the slots are full. @default 0
   */
  readonly maxQueued?: number;
  /**
   * How long a queued call waits for a slot before it is rejected. Unset waits
   * until a slot frees or the caller's signal aborts. The policy's `timeoutMs`
   * does not cover this, since it bounds each attempt and the wait comes first.
   */
  readonly maxWaitMs?: number;
}

/**
 * Raised when every slot and every queue position is taken, or when a queued
 * call waited `maxWaitMs` without a slot. A 503, for the same reason
 * `CircuitOpenError` is one.
 */
export class BulkheadRejectedError extends AppError {
  override name = 'BulkheadRejectedError';
  override readonly status = 503;
}

interface Waiter {
  readonly resolve: () => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Caps how many calls to one dependency run at once, so a slow one cannot hold
 * every connection and every request handler in the process.
 *
 * An instance handed to the policies that share the cap, for the reason
 * `CircuitBreaker` is one. Per process by definition: what it protects is this
 * process's sockets and memory, which a count kept elsewhere knows nothing about.
 *
 * A waiter is served in arrival order, and a released slot passes straight to
 * the next one rather than going back to the pool, so a fresh call cannot jump
 * the queue.
 */
export class Bulkhead {
  readonly #max: number;
  readonly #maxQueued: number;
  readonly #maxWaitMs: number | undefined;
  // A `Set` keeps insertion order, and a waiter whose caller gave up leaves it
  // without a scan.
  readonly #waiting = new Set<Waiter>();
  #active = 0;

  constructor(options: BulkheadOptions) {
    const { maxConcurrent, maxQueued = 0, maxWaitMs } = options;
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new AppError(
        `Bulkhead needs a maxConcurrent of at least 1; got ${maxConcurrent}.`,
      );
    }
    if (!Number.isInteger(maxQueued) || maxQueued < 0) {
      throw new AppError(
        `Bulkhead needs a maxQueued of 0 or more; got ${maxQueued}.`,
      );
    }
    // Finite as well as positive: `setTimeout` fires an infinite delay at once.
    if (
      maxWaitMs !== undefined &&
      !(Number.isFinite(maxWaitMs) && maxWaitMs > 0)
    ) {
      throw new AppError(
        `Bulkhead needs a maxWaitMs above 0, or none; got ${maxWaitMs}.`,
      );
    }
    this.#max = maxConcurrent;
    this.#maxQueued = maxQueued;
    this.#maxWaitMs = maxWaitMs;
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#waiting.size;
  }

  /**
   * Resolves once a slot is held, and every resolution needs exactly one
   * `release`. Rejects with `BulkheadRejectedError` when the queue is full too
   * or `maxWaitMs` passes, or with the signal's reason when the caller gives up
   * while waiting, and none of those holds a slot.
   */
  acquire(signal?: AbortSignal): Promise<void> {
    if (this.#active < this.#max) {
      this.#active += 1;
      return Promise.resolve();
    }
    if (this.#waiting.size >= this.#maxQueued) {
      return Promise.reject(
        new BulkheadRejectedError(
          `Bulkhead is full: ${this.#max} running and ${this.#maxQueued} queued`,
        ),
      );
    }
    if (signal?.aborted === true) return Promise.reject(signal.reason);

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const wait = this.#maxWaitMs;
    const waiter: Waiter = {
      resolve,
      signal,
      onAbort: () => {
        this.#leave(waiter);
        reject(signal?.reason);
      },
      // A `setTimeout` rather than `AbortSignal.timeout`, because a waiter that
      // gets its slot cancels it, and a timeout signal's timer runs out anyway.
      timer:
        wait === undefined
          ? undefined
          : setTimeout(() => {
              this.#leave(waiter);
              reject(
                new BulkheadRejectedError(
                  `Bulkhead had no free slot within ${wait}ms`,
                ),
              );
            }, wait),
    };
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    this.#waiting.add(waiter);
    return promise;
  }

  release(): void {
    const next = this.#waiting.values().next();
    if (next.done === true) {
      this.#active -= 1;
      return;
    }
    this.#leave(next.value);
    next.value.resolve();
  }

  #leave(waiter: Waiter): void {
    this.#waiting.delete(waiter);
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    clearTimeout(waiter.timer);
  }
}
