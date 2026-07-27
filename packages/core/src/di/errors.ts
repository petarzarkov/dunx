export class DunxError extends Error {
  override name = 'DunxError';
}

export class CircularDependencyError extends DunxError {
  override name = 'CircularDependencyError';

  constructor(readonly cycle: readonly string[]) {
    super(`Circular dependency: ${cycle.join(' -> ')}`);
  }
}
