import { AppError } from '@dunx/core';

/**
 * Raised by `@dunx/auth`'s own wiring. better-auth's failures propagate as its
 * `APIError`, and a rejected request is an `HttpError` from `@dunx/http`.
 */
export class AuthError extends AppError {
  override name = 'AuthError';
}
