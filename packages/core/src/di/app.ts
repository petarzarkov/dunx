import { Injector } from './injector.js';
import { hasOnInit, hasOnShutdown } from './lifecycle.js';
import { collectModules, readModule, type ModuleRef } from './module.js';
import type { InjectionToken } from './token.js';

// Declared here rather than reusing NodeJS.Signals so the published .d.ts does
// not oblige consumers to install @types/node.
export type ShutdownSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT';

export interface App {
  /** Resolves once shutdown has finished, whoever triggered it. */
  readonly closed: Promise<void>;
  get<T>(token: InjectionToken<T>): T;
  shutdown(): Promise<void>;
  enableShutdownHooks(signals?: readonly ShutdownSignal[]): this;
}

class Application implements App {
  readonly closed: Promise<void>;
  readonly #injector: Injector;
  #resolveClosed: (() => void) | undefined;
  #shuttingDown: Promise<void> | undefined;
  #hooked = false;

  constructor(injector: Injector) {
    this.#injector = injector;
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  get<T>(token: InjectionToken<T>): T {
    return this.#injector.get(token);
  }

  async shutdown(): Promise<void> {
    this.#shuttingDown ??= (async () => {
      for (const instance of [...this.#injector.instances].reverse()) {
        if (hasOnShutdown(instance)) await instance.onShutdown();
      }
      this.#resolveClosed?.();
    })();
    return this.#shuttingDown;
  }

  enableShutdownHooks(
    signals: readonly ShutdownSignal[] = ['SIGTERM', 'SIGINT'],
  ): this {
    if (this.#hooked) return this;
    this.#hooked = true;
    for (const signal of signals) {
      process.once(signal, () => void this.shutdown());
    }
    return this;
  }
}

export class AppFactory {
  /**
   * Builds the container from the root module's import graph, resolves every
   * provider, and runs `onInit` in dependency order. The returned app is live —
   * there is no separate init step, because dunx resolves eagerly.
   */
  static async create(root: ModuleRef): Promise<App> {
    const injector = new Injector();

    for (const module of collectModules(root)) {
      for (const registration of readModule(module)) {
        injector.register(registration, module.name);
      }
    }
    for (const token of injector.tokens) {
      await injector.resolve(token);
    }
    for (const instance of injector.instances) {
      if (hasOnInit(instance)) await instance.onInit();
    }

    return new Application(injector);
  }
}
