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
 * Every `onDrain` runs concurrently, because these are independent waits and the
 * cost of the phase should be the slowest one rather than their sum. `onShutdown`
 * stays sequential and in reverse resolution order, since teardown follows
 * dependencies and a drain does not.
 */
export interface OnDrain {
  onDrain(): void | Promise<void>;
}

const hasMethod = (value: unknown, name: string): boolean =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as Record<string, unknown>)[name] === 'function';

export const hasOnInit = (value: unknown): value is OnInit =>
  hasMethod(value, 'onInit');

export const hasOnShutdown = (value: unknown): value is OnShutdown =>
  hasMethod(value, 'onShutdown');

export const hasOnDrain = (value: unknown): value is OnDrain =>
  hasMethod(value, 'onDrain');
