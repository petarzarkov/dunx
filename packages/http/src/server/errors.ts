import { AppError } from '@dunx/core';
import { HttpStatusCode } from './status.js';

export class HttpError extends AppError {
  override name = 'HttpError';

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type ErrorMapper = (error: unknown, req: Request) => Response;

export const defaultErrorMapper: ErrorMapper = (error) => {
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
