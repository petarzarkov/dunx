export interface OnInit {
  onInit(): void | Promise<void>;
}

export interface OnShutdown {
  onShutdown(): void | Promise<void>;
}

/**
 * Runs at the start of shutdown, while the app is still serving.
 *
 * `onShutdown` is too late for anything that has to be observable from outside:
 * `@dunx/http` stops the server before tearing providers down, so a hook that
 * flips a readiness probe there answers on a closed port. A load balancer needs
 * the probe to fail *first*, then the port to close once it has stopped routing.
 *
 * Every hook runs concurrently, because these are independent waits and the cost of
 * the phase should be the slowest one rather than their sum. `onShutdown` stays
 * sequential and in reverse resolution order, since teardown follows dependencies
 * and draining does not.
 *
 * Named for when it runs rather than for what it does, because `@OnDrain()` was
 * already taken: `@dunx/http` has exported that as a **websocket handler**
 * decorator since before this phase existed, meaning "backpressure relieved, safe
 * to resume sending". Two `OnDrain`s in one framework is one too many, and this is
 * the newer of them. The phase is still a drain everywhere else - `App.drain()`,
 * `drainDelayMs`, `Readiness.draining` - since none of those collide.
 *
 * It also lines the name up with what it replaces: Nest's
 * `beforeApplicationShutdown` runs before `onApplicationShutdown`, which is this
 * split exactly.
 */
export interface OnBeforeShutdown {
  onBeforeShutdown(): void | Promise<void>;
}

const hasMethod = (value: unknown, name: string): boolean =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as Record<string, unknown>)[name] === 'function';

export const hasOnInit = (value: unknown): value is OnInit =>
  hasMethod(value, 'onInit');

export const hasOnShutdown = (value: unknown): value is OnShutdown =>
  hasMethod(value, 'onShutdown');

export const hasOnBeforeShutdown = (
  value: unknown,
): value is OnBeforeShutdown => hasMethod(value, 'onBeforeShutdown');

/**
 * Every failure a teardown phase collected, as one error.
 *
 * A single failure is passed through unchanged, so the common case still reads like
 * the error it is; several become an `AggregateError`, whose `errors` keeps every
 * original reachable. The point of collecting them at all is that teardown does not
 * stop at the first one: a provider that throws must not be able to keep the
 * providers after it from releasing anything.
 */
export const teardownError = (failures: readonly unknown[]): unknown =>
  failures.length === 1
    ? failures[0]
    : new AggregateError(
        failures,
        `${failures.length} providers failed to shut down`,
      );

/** The inverse, so a phase that collects from another does not nest aggregates. */
export const teardownFailures = (error: unknown): readonly unknown[] =>
  error instanceof AggregateError ? (error.errors as unknown[]) : [error];
