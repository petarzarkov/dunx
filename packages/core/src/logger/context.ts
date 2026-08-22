import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Request-scoped fields, propagated across async boundaries. The well-known keys
 * are named so a log pipeline can rely on them; anything else is allowed.
 */
export interface RequestFields {
  requestId?: string;
  /**
   * W3C Trace Context, when `@dunx/http` was asked to adopt it. 32 hex digits for
   * `traceId` and 16 for the two span ids, so a log pipeline can join these lines
   * to spans emitted by anything else that speaks the same standard.
   */
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  userId?: string;
  method?: string;
  event?: string;
  context?: string;
  flow?: string;
  [key: string]: unknown;
}

export interface RunWithContextOptions {
  /** Inherit the enclosing scope's fields. Default `true`. */
  inherit?: boolean;
}

/**
 * The injectable contract for that store, and the second reason `@dunx/core` has
 * no dependencies: `@dunx/http`'s request logging injects this without pulling a
 * logger implementation in behind it, exactly as it does with {@link Logger}.
 *
 * `@arkv/logger`'s `ContextStore` satisfies this structurally - same three
 * methods, same signatures - so `@dunx/infra/logger` binds one to the other with
 * no adapter class, and the logger then reads the very store the middleware wrote.
 */
export abstract class RequestContext {
  abstract getContext(): RequestFields;
  abstract updateContext(fields: Partial<RequestFields>): void;
  abstract runWithContext<T>(
    context: RequestFields,
    callback: () => T,
    options?: RunWithContextOptions,
  ): T;
}

/**
 * The default binding, used when nothing else claims {@link RequestContext}.
 *
 * `AsyncLocalStorage` is a Node built-in that Bun implements natively, so this
 * costs core no dependency. Importing `@dunx/infra/logger` replaces it with
 * `@arkv/logger`'s store, which is the same thing with the logger already
 * reading from it.
 */
export class AsyncRequestContext extends RequestContext {
  readonly #storage = new AsyncLocalStorage<RequestFields>();

  override getContext(): RequestFields {
    return { ...this.#storage.getStore() };
  }

  override updateContext(fields: Partial<RequestFields>): void {
    const current = this.#storage.getStore();
    if (current) Object.assign(current, fields);
  }

  /**
   * Nested scopes merge. `AsyncLocalStorage.run` on its own replaces the store
   * outright, which would drop the `requestId` an outer scope established - the
   * field a log is most often correlated by. The merged object is fresh, so an
   * `updateContext` inside does not leak back out.
   *
   * The enclosing store is read once and only spread when there is one. A
   * two-source object spread costs 112.9 ns against 21.9 ns for one, and the
   * outermost scope of a request - which is every request - has nothing to merge,
   * so it was paying for a merge with `undefined`. 148.6 ns to 47.2 ns per scope
   * entered; `storage.run` itself is 17.7 ns of that and never was the cost.
   */
  override runWithContext<T>(
    context: RequestFields,
    callback: () => T,
    options?: RunWithContextOptions,
  ): T {
    if (options?.inherit === false) {
      return this.#storage.run(context, callback);
    }
    const enclosing = this.#storage.getStore();
    return this.#storage.run(
      enclosing === undefined ? { ...context } : { ...enclosing, ...context },
      callback,
    );
  }
}
