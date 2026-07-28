import { AppError } from '@dunx/core';

/** Raised by `@dunx/db` itself. Driver failures propagate as the driver's own error. */
export class DatabaseError extends AppError {
  override name = 'DatabaseError';
}
