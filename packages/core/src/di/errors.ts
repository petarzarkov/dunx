export class AppError extends Error {
  override name = 'AppError';
}

export class CircularDependencyError extends AppError {
  override name = 'CircularDependencyError';

  constructor(readonly cycle: readonly string[]) {
    super(`Circular dependency: ${cycle.join(' -> ')}`);
  }
}
