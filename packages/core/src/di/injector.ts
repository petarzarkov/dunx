import { CircularDependencyError, DunxError } from './errors.js';
import { swapInjector } from './inject.js';
import type { ErasedProvider, Registration } from './provider.js';
import { describeToken, isCtor, type InjectionToken } from './token.js';

// Thrown out of the synchronous path when a factory turns out to be async. The
// async caller awaits the token and retries; the factory itself is never called
// twice, because its promise is parked in #settling first.
class PendingSignal {
  constructor(readonly token: InjectionToken<unknown>) {}
}

interface Bound {
  readonly provider: ErasedProvider;
  readonly module: string;
}

export class Injector {
  readonly #bindings = new Map<InjectionToken<unknown>, Bound>();
  readonly #instances = new Map<InjectionToken<unknown>, unknown>();
  readonly #settling = new Map<InjectionToken<unknown>, Promise<unknown>>();
  readonly #building: InjectionToken<unknown>[] = [];
  readonly #order: unknown[] = [];

  register(registration: Registration, module: string): void {
    const existing = this.#bindings.get(registration.token);
    if (existing) {
      throw new DunxError(
        `Duplicate binding for ${describeToken(registration.token)}: bound by module ` +
          `"${existing.module}" and module "${module}". The container is flat — one ` +
          'binding per token.',
      );
    }
    this.#bindings.set(registration.token, {
      provider: registration.provider,
      module,
    });
  }

  get tokens(): readonly InjectionToken<unknown>[] {
    return [...this.#bindings.keys()];
  }

  /** Construction-completion order, so dependencies come before their dependents. */
  get instances(): readonly unknown[] {
    return this.#order;
  }

  get<T>(token: InjectionToken<T>): T {
    const key = token as InjectionToken<unknown>;
    if (this.#instances.has(key)) return this.#instances.get(key) as T;

    if (this.#building.includes(key)) {
      throw new CircularDependencyError(
        [...this.#building, key].map(describeToken),
      );
    }

    // Every class is injectable by default — an unbound constructor self-binds.
    const provider =
      this.#bindings.get(key)?.provider ??
      (isCtor(token) ? ({ kind: 'class', ctor: token } as const) : undefined);

    if (!provider) {
      throw new DunxError(
        `No provider for ${describeToken(token)}. Bind it with provide() in a module.`,
      );
    }

    this.#building.push(key);
    try {
      return this.#instantiate(key, provider) as T;
    } finally {
      this.#building.pop();
    }
  }

  async resolve<T>(token: InjectionToken<T>): Promise<T> {
    const key = token as InjectionToken<unknown>;
    if (this.#instances.has(key)) return this.#instances.get(key) as T;

    const inFlight = this.#settling.get(key);
    if (inFlight) {
      const value = await inFlight;
      this.#settling.delete(key);
      if (!this.#instances.has(key)) this.#settle(key, value);
      return this.#instances.get(key) as T;
    }

    for (;;) {
      try {
        return this.get(token);
      } catch (error) {
        if (!(error instanceof PendingSignal)) throw error;
        await this.resolve(error.token);
      }
    }
  }

  #instantiate(
    key: InjectionToken<unknown>,
    provider: ErasedProvider,
  ): unknown {
    if (provider.kind === 'value') return this.#settle(key, provider.value);

    if (provider.kind === 'class') {
      const previous = swapInjector(this);
      try {
        return this.#settle(key, new provider.ctor());
      } finally {
        swapInjector(previous);
      }
    }

    const deps = provider.deps.map((dep) => this.get(dep));
    const result = provider.factory(...deps);
    if (result instanceof Promise) {
      this.#settling.set(key, result);
      throw new PendingSignal(key);
    }
    return this.#settle(key, result);
  }

  #settle(key: InjectionToken<unknown>, value: unknown): unknown {
    this.#instances.set(key, value);
    this.#order.push(value);
    return value;
  }
}
