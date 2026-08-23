import { AppError, ConsoleLogger, type Ctor, type Logger } from '@dunx/core';
import { HttpStatusCode } from './status.js';

export interface HttpErrorOptions extends ErrorOptions {
  /**
   * Headers the error response carries: `Retry-After` on a 429,
   * `WWW-Authenticate` on a 401, `Allow` on a 405. {@link errorMapper} copies them
   * onto the response; an app replacing the mapper reads them itself.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

export class HttpError extends AppError {
  override name = 'HttpError';
  readonly headers: Readonly<Record<string, string>> | undefined;

  constructor(
    readonly status: number,
    message: string,
    options?: HttpErrorOptions,
  ) {
    super(message, options);
    this.headers = options?.headers;
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
 * The class form of {@link ErrorMapper}, and the one to reach for in an app. A
 * mapper is a function and cannot inject; a filter is resolved from the container
 * exactly as `HttpOptions.middleware` entries are:
 *
 * ```ts
 * export class AppErrorFilter extends ErrorFilter {
 *   constructor(
 *     private readonly logger: Logger,
 *     private readonly config: AppConfigService,
 *   ) {}
 *
 *   catch(error: unknown, req: Request): Response {
 *     ...
 *   }
 * }
 *
 * // It is a provider like any other, so it goes in a module:
 * @Module({ providers: [AppErrorFilter] })
 * // and then:
 * HttpFactory.create(root, { onError: AppErrorFilter });
 * ```
 *
 * `abstract class` rather than an interface, so it is a runtime value and usable
 * as an injection token. Extending it is optional: the check is structural. A
 * filter that cannot handle an error should rethrow or delegate to
 * `defaultErrorMapper`.
 */
export abstract class ErrorFilter {
  abstract catch(error: unknown, req: Request): Response;
}

/** What `onError` accepts. A bare mapper is cheaper where nothing is injected. */
export type ErrorHandler = ErrorMapper | Ctor<ErrorFilter>;

/**
 * Whether `onError` was given a class rather than a mapper. Both are functions, so
 * the discriminator is a prototype carrying a `catch`. `prototype` alone would be
 * wrong: `function mapper() {}` has an empty one.
 */
export const isErrorFilter = (
  handler: ErrorHandler,
): handler is Ctor<ErrorFilter> =>
  typeof handler === 'function' &&
  // A construct signature has no `prototype` in the type system, so `Ctor<T>`
  // cannot be narrowed on one.
  typeof (handler as { prototype?: { catch?: unknown } }).prototype?.catch ===
    'function';

/**
 * Narrows an `ErrorHandler` to the mapper the request path calls. `resolve` is
 * typed for this one token rather than generically, so no caller has to satisfy a
 * polymorphic contract it does not need.
 */
export const toErrorMapper = (
  handler: ErrorHandler,
  resolve: (token: Ctor<ErrorFilter>) => ErrorFilter,
): ErrorMapper =>
  isErrorFilter(handler)
    ? (error, req) => resolve(handler).catch(error, req)
    : handler;

/**
 * The mapper `HttpFactory` installs unless `onError` replaces it, built from the
 * app's bound `Logger`. An `HttpError` is not logged here: the status is the whole
 * record and `RequestLoggingMiddleware` already wrote the line, so only an
 * undeclared error is worth a stack.
 *
 * The error is its own argument, not a field: `JSON.stringify(new Error('x'))` is
 * `{}`, so `{ err: error }` would drop the stack.
 */
export const errorMapper =
  (logger: Logger): ErrorMapper =>
  (error) => {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: error.message, status: error.status, issues: error.issues },
        {
          status: error.status,
          ...(error.headers && { headers: error.headers }),
        },
      );
    }
    if (error instanceof HttpError) {
      return Response.json(
        { error: error.message, status: error.status },
        {
          status: error.status,
          ...(error.headers && { headers: error.headers }),
        },
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
 * `buildFallback` called directly. Writes through core's `ConsoleLogger`, so
 * nothing here emits a multi-line dump a collector reads as several records.
 */
export const defaultErrorMapper: ErrorMapper = errorMapper(new ConsoleLogger());
