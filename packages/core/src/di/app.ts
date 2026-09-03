import { ConsoleLogger } from '../logger/console.js';
import { AsyncRequestContext, RequestContext } from '../logger/context.js';
import { Logger } from '../logger/logger.js';
import { AppError } from './errors.js';
import { Injector } from './injector.js';
import {
  hasOnBeforeShutdown,
  hasOnInit,
  hasOnShutdown,
  teardownError,
  teardownFailures,
} from './lifecycle.js';
import { ROOT_MODULE, type ModuleRef } from './module.js';
import { buildScopes, type Binding } from './scope.js';
import { provide, type Registration } from './provider.js';
import { ShutdownAware, type ShutdownHookOptions } from './shutdown-hooks.js';
import { describeToken, isCtor, type InjectionToken } from './token.js';

/**
 * The two contracts core guarantees are resolvable, laid into the global scope
 * before anything else, so a module binding either one shadows it.
 */
const defaults = (root: ModuleRef): readonly Registration[] => [
  provide(RequestContext, { useClass: AsyncRequestContext }),
  provide(Logger, {
    useFactory: (context: RequestContext) => new ConsoleLogger(context),
    inject: [RequestContext] as const,
  }),
  // Here because this loop is the only place a binding reaches every scope,
  // which is what a global middleware mounted by a feature module needs.
  provide(ROOT_MODULE, { useValue: root }),
  // A holder, filled between resolution and onInit - see AppRef.
  provide(AppRef, { useValue: new AppRef() }),
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
   * Also logged at `warn` by `create()`, since a property nobody reads warns
   * nobody. Public so an app can fail boot on it instead.
   */
  readonly warnings: readonly string[];
  /**
   * Resolves a token, optionally as a named module sees it. Without `from`: the
   * root scope's view, then any single module declaring the token. With `from`:
   * exactly what a provider in that module would get.
   */
  get<T>(token: InjectionToken<T>, from?: ModuleRef): T;
  /**
   * Runs every `onBeforeShutdown` hook concurrently, once, while the app is still
   * serving. `shutdown()` calls it first, so most processes need no separate call.
   */
  drain(): Promise<void>;
  shutdown(): Promise<void>;
  /**
   * Drains on a signal, then **ends the process**. `options.exitAfterMs: false`
   * opts out, for an app embedded in a process it does not own. See
   * {@link ShutdownHooks} for why the drain alone is not enough.
   */
  enableShutdownHooks(
    signals?: readonly ShutdownSignal[],
    options?: ShutdownHookOptions,
  ): this;
}

class Application extends ShutdownAware implements App {
  readonly closed: Promise<void>;
  /** Shadowing notices from the scope graph. Surfaced, not logged: core has no logger. */
  readonly warnings: readonly string[];
  readonly #injector: Injector;
  #resolveClosed: (() => void) | undefined;
  #shuttingDown: Promise<void> | undefined;
  #draining: Promise<void> | undefined;

  constructor(injector: Injector, warnings: readonly string[] = []) {
    super();
    this.#injector = injector;
    this.warnings = warnings;
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  /**
   * The root scope's view first, then any single module declaring the token. More
   * permissive than constructor injection, since this is a bootstrap call rather
   * than a dependency edge. Ambiguity is an error rather than a guess.
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

  /**
   * Every `onBeforeShutdown` hook, concurrently and only once. Separate from
   * `shutdown()` because `@dunx/http` interleaves: drain, stop the server, tear
   * down. Memoized, so the two paths cannot double-drain.
   *
   * `allSettled`, not `all`: one rejecting hook used to abort `shutdown()` before
   * a single `onShutdown` ran, leaking every resource in the app.
   */
  async drain(): Promise<void> {
    this.#draining ??= (async () => {
      const hooks = [...this.#injector.instances].filter(hasOnBeforeShutdown);
      const settled = await Promise.allSettled(
        // `onBeforeShutdown` may be synchronous, and `allSettled` over a bare
        // `void` is what `await-thenable` objects to.
        hooks.map(async (instance) => instance.onBeforeShutdown()),
      );

      const failures: unknown[] = [];
      for (const [index, result] of settled.entries()) {
        if (result.status !== 'rejected') continue;
        this.#report('onBeforeShutdown', hooks[index], result.reason);
        failures.push(result.reason);
      }
      if (failures.length > 0) throw teardownError(failures);
    })();
    return this.#draining;
  }

  /**
   * Every `onShutdown`, in reverse resolution order, and every one of them runs.
   * A throwing hook used to abort the loop, leaving every later provider holding
   * its resources and `closed` pending forever. Failures are collected and thrown
   * last; `closed` resolves in a `finally`.
   */
  async shutdown(): Promise<void> {
    this.#shuttingDown ??= (async () => {
      const failures: unknown[] = [];
      try {
        await this.drain();
      } catch (error) {
        failures.push(...teardownFailures(error));
      }

      try {
        for (const instance of [...this.#injector.instances].reverse()) {
          if (!hasOnShutdown(instance)) continue;
          try {
            await instance.onShutdown();
          } catch (error) {
            this.#report('onShutdown', instance, error);
            failures.push(error);
          }
        }
      } finally {
        this.#resolveClosed?.();
      }

      if (failures.length > 0) throw teardownError(failures);
    })();
    return this.#shuttingDown;
  }

  /**
   * One line per failed hook, naming the provider: a process torn down by a
   * signal has no caller to see the aggregate. The `Logger` lookup is guarded
   * because this runs during teardown, when the logger may itself be gone.
   */
  #report(phase: string, instance: unknown, error: unknown): void {
    const name = (instance as { constructor?: { name?: string } })?.constructor
      ?.name;
    try {
      this.#injector
        .find(Logger)
        .error(`${name ?? 'A provider'}.${phase}() failed`, error);
    } catch {
      console.error(`[dunx] ${name ?? 'A provider'}.${phase}() failed`, error);
    }
  }
}

export interface AppOptions {
  /**
   * Replaces a binding in place, keyed by token, in every scope that holds one -
   * so a test can stub `Logger` without knowing how many modules bind it. An
   * override naming a token nobody binds is an error rather than a silent no-op.
   *
   * The replacement happens before anything resolves, so the discarded provider
   * is never instantiated. `@dunx/testing` is the intended caller.
   */
  readonly overrides?: readonly Registration[];

  /**
   * Extra always-bound contracts, promoted the same way `Logger` and
   * `RequestContext` are: laid into every scope that has no view of its own, and
   * shadowed - without a rebinding warning - by any module that declares the same
   * token.
   *
   * For a framework layer that wraps the app root and needs a contract resolvable
   * everywhere while still letting the app replace it. `@dunx/http` promotes
   * `HttpOptionsProvider` through this. An application has no reason to reach for
   * it; declare the provider in a module instead.
   */
  readonly promote?: readonly Registration[];
}

export class AppFactory {
  /**
   * Builds the container from the root module's import graph, resolves every
   * provider, and runs `onInit` in dependency order. The returned app is live.
   */
  static async create(root: ModuleRef, options: AppOptions = {}): Promise<App> {
    const graph = buildScopes(root);
    const overrides = new Map<InjectionToken<unknown>, Registration>(
      (options.overrides ?? []).map((entry) => [entry.token, entry]),
    );
    const replaced = new Set<InjectionToken<unknown>>();

    /**
     * An override replaces the binding in every scope that holds it. Where two
     * scopes bind a token differently and only one is meant, the test resolves
     * through the module it cares about instead.
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
      // `visible` was flattened earlier, so a substituted import is re-pointed.
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
     * `Logger` and `RequestContext` are promoted rather than merely defaulted:
     * whichever module declares one, that binding is laid into every scope with no
     * view of its own. Without this a `Logger` bound in a feature module would be
     * invisible to `@dunx/infra`'s scopes, which import nothing of the app's.
     */
    for (const registration of [
      ...defaults(root),
      ...(options.promote ?? []),
    ]) {
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

    // An unlisted class still self-binds, so an override for one has a binding to
    // replace. A `token()` nobody bound stays an error: nothing self-binds behind
    // it, so it would be adding rather than replacing.
    for (const [token, registration] of overrides) {
      if (replaced.has(token) || !isCtor(token)) continue;
      injector.registerLazy(registration);
      replaced.add(token);
    }
    assertEveryOverrideReplaced(overrides, replaced);

    for (const { scope, token } of injector.eager) {
      await injector.resolve(token, scope);
    }
    // Before `onInit`, so `AppRef` is usable there.
    const app = new Application(injector, graph.warnings);
    injector.find(AppRef).attach(app);

    for (const instance of injector.instances) {
      if (hasOnInit(instance)) await instance.onInit();
    }

    // After onInit, so an app that bound its own Logger writes these through it.
    for (const warning of graph.warnings) app.get(Logger).warn(warning);
    return app;
  }
}

/**
 * The container, injectable. For the narrow case of a provider that must resolve
 * a token it cannot name at build time: `@dunx/infra/queue`'s runner finds
 * `@JobHandler` methods anywhere in the graph and resolves each declaring class.
 *
 * Only usable from `onInit` onwards - the container is still resolving while
 * constructors run, so `current` throws there rather than hand back a half-built
 * graph. That is why this is a holder rather than the `App`.
 */
export class AppRef {
  #app: App | undefined;

  get current(): App {
    if (this.#app === undefined) {
      throw new AppError(
        'AppRef was read during construction. The container is still resolving ' +
          'at that point, so there is nothing to hand back. Read it in onInit(), ' +
          'which runs once every provider exists.',
      );
    }
    return this.#app;
  }

  /** Called once by `AppFactory.create`, between resolution and `onInit`. */
  attach(app: App): void {
    this.#app = app;
  }
}
