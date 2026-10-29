import { AppError } from '../di/errors.js';

export interface BulkheadOptions {
  /** Calls allowed to run at once. */
  readonly maxConcurrent: number;
  /**
   * Calls allowed to wait for a slot once every one is taken, beyond which a
   * call is rejected. 0 rejects as soon as the slots are full. @default 0
   */
  readonly maxQueued?: number;
}

/**
 * Raised when every slot and every queue position is taken. A 503, for the same
 * reason `CircuitOpenError` is one.
 */
export class BulkheadRejectedError extends AppError {
  override name = 'BulkheadRejectedError';
  override readonly status = 503;

  constructor(maxConcurrent: number, maxQueued: number) {
    super(`Bulkhead is full: ${maxConcurrent} running and ${maxQueued} queued`);
  }
}

interface Waiter {
  readonly resolve: () => void;
  readonly signal: AbortSignal | undefined;
  readonly onAbort: () => void;
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
  // A `Set` keeps insertion order, and a waiter whose caller gave up leaves it
  // without a scan.
  readonly #waiting = new Set<Waiter>();
  #active = 0;

  constructor(options: BulkheadOptions) {
    const { maxConcurrent, maxQueued = 0 } = options;
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
    this.#max = maxConcurrent;
    this.#maxQueued = maxQueued;
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#waiting.size;
  }

  /**
   * Resolves once a slot is held, and every resolution needs exactly one
   * `release`. Rejects with `BulkheadRejectedError` when the queue is full too,
   * or with the signal's reason when the caller gives up while waiting, and
   * neither of those holds a slot.
   */
  acquire(signal?: AbortSignal): Promise<void> {
    if (this.#active < this.#max) {
      this.#active += 1;
      return Promise.resolve();
    }
    if (this.#waiting.size >= this.#maxQueued) {
      return Promise.reject(
        new BulkheadRejectedError(this.#max, this.#maxQueued),
      );
    }
    if (signal?.aborted === true) return Promise.reject(signal.reason);

    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const waiter: Waiter = {
      resolve,
      signal,
      onAbort: () => {
        this.#waiting.delete(waiter);
        reject(signal?.reason);
      },
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
    const waiter = next.value;
    this.#waiting.delete(waiter);
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    waiter.resolve();
  }
}
