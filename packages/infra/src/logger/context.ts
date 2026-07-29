import { AsyncLocalStorage } from 'node:async_hooks';
import type { AsyncContext } from './types.js';

/**
 * Request-scoped fields, held outside the container. `docs/ARCHITECTURE.md`
 * sanctions `AsyncLocalStorage` for exactly this: the framework is
 * singleton-only, so the store is one instance whose *contents* differ per async
 * flow. Nothing here participates in resolution, and there are no request-scoped
 * providers.
 */
export class ContextStore {
  readonly #storage = new AsyncLocalStorage<AsyncContext>();

  /** A copy, so a caller cannot mutate the live store by holding the result. */
  getContext(): AsyncContext {
    const context = this.#storage.getStore();
    return context ? { ...context } : {};
  }

  /** A no-op outside any `runWithContext` — there is nothing to write to. */
  updateContext(fields: Partial<AsyncContext>): void {
    const context = this.#storage.getStore();
    if (context) Object.assign(context, fields);
  }

  runWithContext<T>(context: AsyncContext, callback: () => T): T {
    return this.#storage.run(context, callback);
  }
}
