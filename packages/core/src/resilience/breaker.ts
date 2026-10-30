import { AppError } from '../di/errors.js';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface FailureRate {
  /** The share of attempts in the window that opens the circuit, above 0 and at most 1. */
  readonly ratio: number;
  /** How many of the most recent attempts the ratio is taken over. */
  readonly window: number;
  /**
   * Attempts recorded before the ratio is trusted, so one failure out of one
   * does not open it. At most `window`. @default window
   */
  readonly minimumCalls?: number;
}

export interface CircuitBreakerOptions {
  /**
   * Consecutive failures that open the circuit. @default 5, or off when only
   * `failureRate` is given
   */
  readonly failureThreshold?: number;
  /**
   * Opens on the share of recent attempts that failed rather than on a run of
   * them, so an upstream failing every other call still trips it. With
   * `failureThreshold` too, whichever is reached first opens it.
   */
  readonly failureRate?: FailureRate;
  /** How long the circuit stays open before a probe is let through. @default 30_000 */
  readonly openMs?: number;
  /** Attempts let through at once while half-open. @default 1 */
  readonly halfOpenProbes?: number;
  /**
   * Whether an error counts against the dependency. An error this declines
   * leaves the circuit as it is: a 404 or a validation failure is the dependency
   * answering, not the dependency being down.
   *
   * Defaults to every error except an `AbortError`, which is the caller giving
   * up. A `TimeoutError` counts: a dependency too slow to answer is unhealthy.
   */
  readonly isFailure?: (error: unknown) => boolean;
  readonly onStateChange?: (to: CircuitState, from: CircuitState) => void;
}

/**
 * Raised instead of an attempt while the circuit is open, or half-open with
 * every probe in flight. A 503, so an unhandled one leaves `@dunx/http` as a
 * response rather than a 500.
 */
export class CircuitOpenError extends AppError {
  override name = 'CircuitOpenError';
  override readonly status = 503;

  constructor(readonly state: CircuitState) {
    super(`Circuit is ${state}; the call was not attempted`);
  }
}

const notAborted = (error: unknown): boolean =>
  !(error instanceof Error && error.name === 'AbortError');

const positiveInteger = (name: string, value: number): number => {
  if (!Number.isInteger(value) || value < 1) {
    throw new AppError(
      `CircuitBreaker needs a ${name} of at least 1; got ${value}.`,
    );
  }
  return value;
};

/** The last `size` outcomes as a ring, with the failures among them counted. */
class Outcomes {
  readonly #failed: boolean[] = [];
  #next = 0;
  #failures = 0;

  constructor(
    private readonly size: number,
    private readonly minimum: number,
    private readonly ratio: number,
  ) {}

  /** Records one outcome and answers whether the window now opens the circuit. */
  push(failed: boolean): boolean {
    if (this.#failed[this.#next] === true) this.#failures -= 1;
    this.#failed[this.#next] = failed;
    if (failed) this.#failures += 1;
    this.#next = (this.#next + 1) % this.size;
    const held = this.#failed.length;
    return held >= this.minimum && this.#failures / held >= this.ratio;
  }

  clear(): void {
    this.#failed.length = 0;
    this.#next = 0;
    this.#failures = 0;
  }
}

const outcomesFor = (rate: FailureRate): Outcomes => {
  if (!(rate.ratio > 0 && rate.ratio <= 1)) {
    throw new AppError(
      `CircuitBreaker needs a failureRate.ratio above 0 and at most 1; got ${rate.ratio}.`,
    );
  }
  const window = positiveInteger('failureRate.window', rate.window);
  const minimum = positiveInteger(
    'failureRate.minimumCalls',
    rate.minimumCalls ?? window,
  );
  if (minimum > window) {
    throw new AppError(
      `CircuitBreaker's failureRate.minimumCalls (${minimum}) is over its ` +
        `window (${window}), so the ratio could never be read.`,
    );
  }
  return new Outcomes(window, minimum, rate.ratio);
};

/**
 * Stops calling a dependency that keeps failing.
 *
 * Closed counts consecutive failures and opens at `failureThreshold`, or on
 * `failureRate` over a window of recent attempts. Open
 * rejects every attempt until `openMs` has passed, then lets `halfOpenProbes`
 * through: a probe that resolves closes it, one that fails opens it again.
 *
 * **An instance, not options, because the state has to outlive a policy.**
 * `HttpService` builds a policy per call, and a breaker built with it would
 * forget every failure the moment the call returned. One breaker per
 * dependency, handed to every policy that calls it.
 *
 * Per process. Each replica sees its own failures and opens on its own, which is
 * what Polly, resilience4j and opossum do: a breaker read from Redis puts a
 * network call in front of every attempt, during the outage it exists for.
 */
export class CircuitBreaker {
  readonly #threshold: number;
  readonly #outcomes: Outcomes | undefined;
  readonly #openMs: number;
  readonly #probes: number;
  readonly #isFailure: (error: unknown) => boolean;
  readonly #onStateChange:
    | ((to: CircuitState, from: CircuitState) => void)
    | undefined;
  #state: CircuitState = 'closed';
  #failures = 0;
  #openedAt = 0;
  #inFlight = 0;

  constructor(options: CircuitBreakerOptions = {}) {
    const { failureThreshold, failureRate } = options;
    this.#threshold =
      failureThreshold !== undefined
        ? positiveInteger('failureThreshold', failureThreshold)
        : failureRate === undefined
          ? 5
          : Infinity;
    this.#outcomes =
      failureRate === undefined ? undefined : outcomesFor(failureRate);
    this.#openMs = options.openMs ?? 30_000;
    this.#probes = positiveInteger(
      'halfOpenProbes',
      options.halfOpenProbes ?? 1,
    );
    this.#isFailure = options.isFailure ?? notAborted;
    this.#onStateChange = options.onStateChange;
  }

  /**
   * As of the last attempt. An open circuit whose `openMs` has passed still
   * reads `open` until something asks to be let through.
   */
  get state(): CircuitState {
    return this.#state;
  }

  /**
   * Asks to make an attempt. Answers the error to raise instead, or `undefined`
   * when the attempt may go ahead, in which case exactly one `success` or
   * `failure` must follow: a half-open probe is held until then.
   */
  admit(): CircuitOpenError | undefined {
    if (this.#state === 'open' && Date.now() - this.#openedAt >= this.#openMs) {
      this.#move('half-open');
    }
    if (this.#state === 'open') return new CircuitOpenError('open');
    if (this.#state === 'half-open') {
      if (this.#inFlight >= this.#probes) {
        return new CircuitOpenError('half-open');
      }
      this.#inFlight += 1;
    }
    return undefined;
  }

  success(): void {
    if (this.#state === 'half-open') {
      this.#move('closed');
      return;
    }
    if (this.#state === 'open') return;
    this.#failures = 0;
    this.#outcomes?.push(false);
  }

  failure(error: unknown): void {
    if (!this.#isFailure(error)) {
      // Floored, since an attempt admitted while closed can land here too and
      // never held a probe.
      if (this.#state === 'half-open') {
        this.#inFlight = Math.max(0, this.#inFlight - 1);
      }
      return;
    }
    if (this.#state === 'half-open') {
      this.#open();
      return;
    }
    // A late attempt landing while already open changes nothing, and must not
    // push `openedAt` forward.
    if (this.#state === 'open') return;
    this.#failures += 1;
    // Recorded before the comparison, so the window holds this failure either
    // way; the `||` would skip the push once the run alone opened it.
    const rateTripped = this.#outcomes?.push(true) === true;
    if (rateTripped || this.#failures >= this.#threshold) this.#open();
  }

  #open(): void {
    this.#openedAt = Date.now();
    this.#move('open');
  }

  // The state changes before the hook runs, so a throwing hook propagates
  // without leaving the circuit between two states.
  #move(to: CircuitState): void {
    const from = this.#state;
    this.#state = to;
    this.#inFlight = 0;
    this.#failures = 0;
    this.#outcomes?.clear();
    this.#onStateChange?.(to, from);
  }
}
