import { AppError } from '@dunx/core';

/** Raised by `@dunx/infra/db` itself. Driver failures propagate as the driver's own error. */
export class DatabaseError extends AppError {
  override name = 'DatabaseError';
}
