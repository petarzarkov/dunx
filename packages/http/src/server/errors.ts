import { AppError } from '@dunx/core';
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

export const defaultErrorMapper: ErrorMapper = (error) => {
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
  console.error(error);
  return Response.json(
    {
      error: 'Internal Server Error',
      status: HttpStatusCode.INTERNAL_SERVER_ERROR,
    },
    { status: HttpStatusCode.INTERNAL_SERVER_ERROR },
  );
};
