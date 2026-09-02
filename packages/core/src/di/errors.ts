export class AppError extends Error {
  override name = 'AppError';
  /**
   * The HTTP status this error should become, if it should become one.
   *
   * **An integer is not the web layer**, which is the whole point: `@dunx/infra`
   * must not depend on `@dunx/http`, so it cannot raise an `HttpError` or ship a
   * filter that imports one. It can declare a number. `@dunx/http`'s default
   * mapper honours any `AppError` carrying one and sends everything else to 500,
   * so the package that raised an error owns what it means without the two
   * packages knowing about each other.
   *
   * Undefined is not "no opinion, use 500" by accident: it is the honest answer
   * for a `CircularDependencyError`, which is a boot failure and not a response.
   */
  readonly status?: number;
}

export class CircularDependencyError extends AppError {
  override name = 'CircularDependencyError';

  constructor(readonly cycle: readonly string[]) {
    super(`Circular dependency: ${cycle.join(' -> ')}`);
  }
}
