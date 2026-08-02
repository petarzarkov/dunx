import { AppError, ConsoleLogger, type Logger } from '@dunx/core';
import { HttpStatusCode } from './status.js';

export class HttpError extends AppError {
  override name = 'HttpError';

  constructor(
    readonly status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** Which declared schema rejected the request. */
export type InputSource = 'body' | 'query' | 'params';

/** A Standard Schema issue, flattened: `path` is dotted, or absent at the root. */
export interface ValidationIssue {
  readonly message: string;
  readonly path?: string;
}

/**
 * A declared schema rejected the input. Always a 400, and the issues survive into
 * the response body - a caller cannot fix what it cannot see.
 */
export class ValidationError extends HttpError {
  override name = 'ValidationError';

  constructor(
    readonly source: InputSource,
    readonly issues: readonly ValidationIssue[],
  ) {
    super(HttpStatusCode.BAD_REQUEST, `Invalid ${source}`);
  }
}

export type ErrorMapper = (error: unknown, req: Request) => Response;

/**
 * The mapper `HttpFactory` installs unless `onError` replaces it, built from the
 * app's **bound** `Logger` - so a service that imported `@dunx/infra/logger` gets
 * the stack as one `@arkv/logger` entry, sanitized and shaped like every other.
 *
 * An `HttpError` is not logged here at all: the status is the whole record, and
 * `RequestLoggingMiddleware` already writes the 4xx line. Only an error nothing
 * declared - the one that becomes a 500 - is worth a stack.
 *
 * The error goes in as its own argument rather than as a field of an object.
 * `JSON.stringify(new Error('x'))` is `{}`, so `{ err: error }` would drop the
 * stack; every `Logger` implementation picks an `Error` argument out and
 * serialises it.
 */
export const errorMapper =
  (logger: Logger): ErrorMapper =>
  (error) => {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: error.message, status: error.status, issues: error.issues },
        { status: error.status },
      );
    }
    if (error instanceof HttpError) {
      return Response.json(
        { error: error.message, status: error.status },
        { status: error.status },
      );
    }
    logger.error('Unhandled error', error);
    return Response.json(
      {
        error: 'Internal Server Error',
        status: HttpStatusCode.INTERNAL_SERVER_ERROR,
      },
      { status: HttpStatusCode.INTERNAL_SERVER_ERROR },
    );
  };

/**
 * The same mapper with no container behind it, for `buildRoutes` and
 * `buildFallback` called directly. It writes through core's `ConsoleLogger`, which
 * is one JSON line - the point being that nothing in this package ever reaches for
 * `console.error` and emits a multi-line dump a collector reads as several broken
 * records. An app gets {@link errorMapper} over its own bound logger instead.
 */
export const defaultErrorMapper: ErrorMapper = errorMapper(new ConsoleLogger());
