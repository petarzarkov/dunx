import { ConsoleLogger } from '../logger/console.js';
import { AsyncRequestContext, RequestContext } from '../logger/context.js';
import { Logger } from '../logger/logger.js';
import { AppError } from './errors.js';
import { Injector } from './injector.js';
import { hasOnInit, hasOnShutdown } from './lifecycle.js';
import { collectModules, readModule, type ModuleRef } from './module.js';
import { provide, type Registration } from './provider.js';
import { describeToken, type InjectionToken } from './token.js';

/**
 * The two contracts core guarantees are resolvable. Both are last-resort: a
 * module binding either one replaces it, and `@dunx/infra/logger` binds both.
 */
const defaults = (): readonly Registration[] => [
  provide(RequestContext, { useClass: AsyncRequestContext }),
  provide(Logger, {
    useFactory: (context: RequestContext) => new ConsoleLogger(context),
    inject: [RequestContext] as const,
  }),
];

const assertEveryOverrideReplaced = (
  overrides: ReadonlyMap<InjectionToken<unknown>, Registration>,
  replaced: ReadonlySet<InjectionToken<unknown>>,
): void => {
  const missing = [...overrides.keys()].filter((token) => !replaced.has(token));
  if (missing.length === 0) return;

  throw new AppError(
    `Nothing to override for ${missing.map(describeToken).join(', ')}: no module ` +
      'in the graph binds it. An override replaces a binding - it cannot add one, ' +
      'because a token nobody bound is a token nothing under test resolves.',
  );
};

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

export interface AppOptions {
  /**
   * Replaces a binding **in place**, keyed by token, as the flat list is
   * assembled. Not an extra module appended at the end: the container is flat and
   * one token has exactly one binding, so a late binding would be a duplicate
   * rather than a winner. The count per token never changes, which is why the
   * duplicate-binding check still runs unmodified.
   *
   * An override naming a token nobody binds is an error - a silent no-op there is
   * a test that asserts against the real provider it thought it had swapped.
   *
   * Because the replacement happens before anything resolves, the discarded
   * provider is never instantiated: its `useFactory` never runs and its `onInit`
   * never fires. That is what makes overriding a database safe.
   *
   * `@dunx/testing`'s `createTestApp({ modules, overrides })` is the intended
   * caller.
   */
  readonly overrides?: readonly Registration[];
}

export class AppFactory {
  /**
   * Builds the container from the root module's import graph, resolves every
   * provider, and runs `onInit` in dependency order. The returned app is live -
   * there is no separate init step, because dunx resolves eagerly.
   */
  static async create(root: ModuleRef, options: AppOptions = {}): Promise<App> {
    const injector = new Injector();
    const overrides = new Map<InjectionToken<unknown>, Registration>(
      (options.overrides ?? []).map((entry) => [entry.token, entry]),
    );
    const replaced = new Set<InjectionToken<unknown>>();
    const substitute = (registration: Registration): Registration => {
      const override = overrides.get(registration.token);
      if (!override) return registration;
      replaced.add(registration.token);
      return override;
    };

    for (const module of collectModules(root)) {
      for (const registration of readModule(module)) {
        injector.register(substitute(registration), module.name);
      }
    }
    // After every module, so an app that binds either of these wins. Offered at
    // all so `Logger` and `RequestContext` are injectable with no logging module
    // imported - which is what lets @dunx/http log requests out of the box.
    // Substituted too, so overriding `Logger` works in an app that binds none.
    for (const registration of defaults()) {
      injector.registerDefault(substitute(registration));
    }
    assertEveryOverrideReplaced(overrides, replaced);

    for (const token of injector.tokens) {
      await injector.resolve(token);
    }
    for (const instance of injector.instances) {
      if (hasOnInit(instance)) await instance.onInit();
    }

    return new Application(injector);
  }
}
