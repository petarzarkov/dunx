import { AppError, ConsoleLogger, type Ctor, type Logger } from '@dunx/core';
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
 * The class form of {@link ErrorMapper}, and the one to reach for in an app.
 *
 * A mapper is a function, which means it cannot inject: the interesting ones need
 * the app's config to decide how much of an error to reveal, or its `Logger` to
 * record the ones that became a 500. dunx's own default proves the point - it is
 * `errorMapper(logger)`, a curried factory, because currying was the only way to
 * hand a function a dependency.
 *
 * A filter is resolved **from the container**, exactly as `HttpOptions.middleware`
 * entries are, so it takes whatever it needs as constructor parameters:
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
 * `abstract class` rather than an interface, so it is a runtime value and therefore
 * usable as an injection token - an app that wants to swap filters by binding one
 * can. Extending it is optional: `onError` accepts any class with a matching
 * `catch`, because the check is structural.
 *
 * The method is `catch` to match the vocabulary of the thing it replaces, NestJS's
 * `ExceptionFilter.catch`. A filter that cannot handle an error should rethrow it,
 * or delegate to `defaultErrorMapper`.
 */
export abstract class ErrorFilter {
  abstract catch(error: unknown, req: Request): Response;
}

/**
 * What `onError` accepts. A bare mapper still works and is the cheaper thing for a
 * filter with no dependencies; a class is what an app that needs one uses.
 */
export type ErrorHandler = ErrorMapper | Ctor<ErrorFilter>;

/**
 * Whether `onError` was given a class rather than a mapper.
 *
 * Both are `typeof === 'function'`, so the discriminator is the prototype carrying
 * a `catch`: a class declaration always has one, and neither an arrow function nor
 * a `function` expression ever does. Checking `prototype` alone would be wrong -
 * `function mapper() {}` has an empty one.
 */
export const isErrorFilter = (
  handler: ErrorHandler,
): handler is Ctor<ErrorFilter> =>
  typeof handler === 'function' &&
  // Narrowed through a structural shape rather than `Ctor`: a construct signature
  // has no `prototype` in the type system, so `Partial<Ctor<T>>` cannot see it.
  typeof (handler as { prototype?: { catch?: unknown } }).prototype?.catch ===
    'function';

/**
 * Narrows an `ErrorHandler` to the mapper the request path actually calls.
 *
 * `resolve` is typed for this one token rather than generically: the only thing ever
 * looked up here is the filter, and a `<T>(token: Ctor<T>) => T` signature makes
 * every caller - a test included - satisfy a polymorphic contract it does not need.
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
