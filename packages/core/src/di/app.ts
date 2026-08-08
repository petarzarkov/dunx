import { ConsoleLogger } from '../logger/console.js';
import { AsyncRequestContext, RequestContext } from '../logger/context.js';
import { Logger } from '../logger/logger.js';
import { AppError } from './errors.js';
import { Injector } from './injector.js';
import { hasOnInit, hasOnShutdown } from './lifecycle.js';
import { ROOT_MODULE, type ModuleRef } from './module.js';
import { buildScopes, type Binding } from './scope.js';
import { provide, type Registration } from './provider.js';
import { describeToken, isCtor, type InjectionToken } from './token.js';

/**
 * The two contracts core guarantees are resolvable, as bindings laid into the
 * **global** scope before anything else.
 *
 * Under the flat container these were appended after every module so an app binding
 * either one won. Module scoping does that job better and without a special case: the
 * global scope is laid down first and a module's own bindings go over it, so an app
 * that binds `Logger` shadows this automatically. `@dunx/infra/logger` binds both.
 */
const defaults = (root: ModuleRef): readonly Registration[] => [
  provide(RequestContext, { useClass: AsyncRequestContext }),
  provide(Logger, {
    useFactory: (context: RequestContext) => new ConsoleLogger(context),
    inject: [RequestContext] as const,
  }),
  // Not a contract with an alternative implementation - there is one root and this
  // is it. It rides along here because this loop is the only place a binding can be
  // laid into every scope, which is what a global middleware mounted by a feature
  // module needs. See ROOT_MODULE.
  provide(ROOT_MODULE, { useValue: root }),
];

const assertEveryOverrideReplaced = (
  overrides: ReadonlyMap<InjectionToken<unknown>, Registration>,
  replaced: ReadonlySet<InjectionToken<unknown>>,
): void => {
  const missing = [...overrides.keys()].filter((token) => !replaced.has(token));
  if (missing.length === 0) return;

  throw new AppError(
    `Nothing to override for ${missing.map(describeToken).join(', ')}: no module ` +
      'in the graph binds it, and it is not a class, so nothing self-binds it ' +
      'either. An override replaces a binding - it cannot add one, because a ' +
      'token nobody bound is a token nothing under test resolves.',
  );
};

// Declared here rather than reusing NodeJS.Signals so the published .d.ts does
// not oblige consumers to install @types/node.
export type ShutdownSignal = 'SIGTERM' | 'SIGINT' | 'SIGHUP' | 'SIGQUIT';

export interface App {
  /** Resolves once shutdown has finished, whoever triggered it. */
  readonly closed: Promise<void>;
  /**
   * Shadowing and ambiguous-import notices from the scope graph, in boot order.
   * Empty on a graph with no ambiguity.
   *
   * **Also logged, at `warn`, by `create()`.** Surfacing them on a property and
   * leaving the caller to print them was the original design, on the reasoning that
   * core had no logger. It does - `Logger` is one of the two always-bound contracts -
   * and the reasoning failed its first real test: `dunx-template` never read this
   * property, so a shadowed binding would have been silent in the one app most likely
   * to hit one. These exist so nobody loses hours; a property nobody reads cannot do
   * that. The list stays public for an app that wants to fail boot on it instead.
   */
  readonly warnings: readonly string[];
  /**
   * Resolves a token, optionally **as a named module sees it**.
   *
   * Without `from` this is the permissive bootstrap lookup: the root scope's view,
   * then any single module that declares the token. With `from` it is exactly what a
   * provider in that module would get, which is what a framework wrapping an app
   * needs - `@dunx/http` resolves global middleware as the *app's* root sees it, not
   * as its own wrapper module does.
   */
  get<T>(token: InjectionToken<T>, from?: ModuleRef): T;
  shutdown(): Promise<void>;
  enableShutdownHooks(signals?: readonly ShutdownSignal[]): this;
}

class Application implements App {
  readonly closed: Promise<void>;
  /** Shadowing notices from the scope graph. Surfaced, not logged: core has no logger. */
  readonly warnings: readonly string[];
  readonly #injector: Injector;
  #resolveClosed: (() => void) | undefined;
  #shuttingDown: Promise<void> | undefined;
  #hooked = false;

  constructor(injector: Injector, warnings: readonly string[] = []) {
    this.#injector = injector;
    this.warnings = warnings;
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  /**
   * The root scope's view first, then any single module that declares the token.
   *
   * Deliberately more permissive than constructor injection: this is a bootstrap and
   * debugging call, not a dependency edge, so requiring every caller to know which
   * module owns a provider would make `exports` painful for no safety gain. Ambiguity
   * is still an error rather than a guess.
   */
  get<T>(token: InjectionToken<T>, from?: ModuleRef): T {
    if (from === undefined) return this.#injector.find(token);
    const scope = this.#injector.graph.scopes.get(from);
    if (!scope) {
      throw new AppError(
        `${describeToken(from as InjectionToken<unknown>)} is not a module in this ` +
          'container, so it has no scope to resolve from. Pass a module reference the ' +
          'graph was built with.',
      );
    }
    return this.#injector.find(token, scope);
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
    const graph = buildScopes(root);
    const overrides = new Map<InjectionToken<unknown>, Registration>(
      (options.overrides ?? []).map((entry) => [entry.token, entry]),
    );
    const replaced = new Set<InjectionToken<unknown>>();

    /**
     * An override replaces the binding in **every scope that holds it**, not in one.
     *
     * A test that stubs `Logger` should not have to know how many modules bind it, and
     * making it name a scope would push container topology into every suite. Where two
     * scopes genuinely bind a token differently and only one is meant, the test can
     * resolve through the module it cares about instead.
     */
    for (const scope of graph.ordered) {
      for (const [token, binding] of scope.own) {
        const override = overrides.get(token);
        if (!override) continue;
        const substituted: Binding = {
          provider: override.provider,
          module: binding.module,
        };
        scope.own.set(token, substituted);
        replaced.add(token);
      }
      // `visible` was flattened before this, so an imported binding that has just
      // been substituted has to be re-pointed here too.
      for (const [token] of scope.visible) {
        const override = overrides.get(token);
        if (!override) continue;
        scope.visible.set(token, {
          provider: override.provider,
          module: scope.visible.get(token)?.module ?? '(override)',
        });
        replaced.add(token);
      }
    }

    /**
     * Core's two always-bound contracts, `Logger` and `RequestContext`.
     *
     * The documented rule is that **a module binding either one wins**, app-wide -
     * that is what lets `@dunx/http`'s request logging use an app's real logger while
     * still working in an app that imported no logging module at all. Module scoping
     * would otherwise break it: a `Logger` bound in some feature module is invisible
     * to `@dunx/infra`'s scopes, which import nothing of the app's.
     *
     * So these two are promoted rather than merely defaulted. Whichever module
     * declares one, that binding is laid into every scope that has no view of its own;
     * only if nobody declares it does core's fallback go in. `LoggerModule` is
     * `global: true` and lands here through the ordinary path as well.
     */
    for (const registration of defaults(root)) {
      const substituted = overrides.get(registration.token);
      if (substituted) replaced.add(registration.token);

      const declared = graph.ordered.find((scope) =>
        scope.own.has(registration.token),
      );
      const binding: Binding = substituted
        ? { provider: substituted.provider, module: '(override)' }
        : (declared?.own.get(registration.token) ?? {
            provider: registration.provider,
            module: '(default)',
          });

      for (const scope of graph.ordered) {
        if (scope.own.has(registration.token)) continue;
        scope.visible.set(registration.token, binding);
      }
    }

    const injector = new Injector(graph);

    // A class no module listed is still resolvable, because an unbound constructor
    // self-binds. So an override for one does have a binding to replace, and refusing
    // it contradicted the container about the same class in the same graph - while the
    // collaborator nobody listed is exactly what a unit test stubs. A `token()` nobody
    // bound stays an error: there is no self-binding behind it, so it really would be
    // adding rather than replacing.
    for (const [token, registration] of overrides) {
      if (replaced.has(token) || !isCtor(token)) continue;
      injector.registerLazy(registration);
      replaced.add(token);
    }
    assertEveryOverrideReplaced(overrides, replaced);

    for (const { scope, token } of injector.eager) {
      await injector.resolve(token, scope);
    }
    for (const instance of injector.instances) {
      if (hasOnInit(instance)) await instance.onInit();
    }

    const app = new Application(injector, graph.warnings);
    // After onInit, so an app that bound its own Logger writes these through it
    // rather than through the default that was about to be replaced.
    for (const warning of graph.warnings) app.get(Logger).warn(warning);
    return app;
  }
}
