import { isUnresolved, readDeps, type Constructible } from './deps.js';
import { CircularDependencyError, AppError } from './errors.js';
import { swapScope } from './inject.js';
import { missingTransformMessage } from './transform-hint.js';
import {
  unresolvableMessage,
  type Binding,
  type Scope,
  type ScopeGraph,
} from './scope.js';
import type { Registration } from './provider.js';
import {
  describeToken,
  isCtor,
  type Ctor,
  type InjectionToken,
} from './token.js';

// Thrown out of the synchronous path when a factory turns out to be async. The
// async caller awaits the token and retries; the factory itself is never called
// twice, because its promise is parked in #settling first.
class PendingSignal {
  constructor(
    readonly binding: Binding,
    readonly scope: Scope,
  ) {}
}

/**
 * Resolves tokens against a graph of module scopes.
 *
 * The instance caches key on the **binding**, not the token: two modules that each
 * declare `UsersService` hold two bindings and therefore two instances, which is the
 * per-module rebinding module scoping exists to allow. Under the flat container that
 * was a duplicate-token boot error.
 *
 * `#building` is shared across every scope rather than per scope, so a construction
 * cycle that spans two modules is still caught with the full path. A cycle in module
 * *imports* is fine and unrelated - see the resolution notes in
 * docs/roadmap/module-scoped-di.md.
 */
export class Injector {
  readonly #graph: ScopeGraph;
  readonly #instances = new Map<Binding, unknown>();
  readonly #settling = new Map<Binding, Promise<unknown>>();
  readonly #building: { binding: Binding; token: InjectionToken<unknown> }[] =
    [];
  readonly #order: unknown[] = [];
  /** Bindings added after boot: overrides for tokens nobody declared. */
  readonly #lazy = new Map<InjectionToken<unknown>, Binding>();

  constructor(graph: ScopeGraph) {
    this.#graph = graph;
  }

  get graph(): ScopeGraph {
    return this.#graph;
  }

  /**
   * Bind without joining the eager set, so it is constructed only if something asks.
   *
   * This is how an override for a class no module lists behaves the same as the
   * self-binding it replaces: a self-bound class has no declared binding and is built
   * on demand, so registering its override eagerly would construct a stub for a
   * collaborator the graph under test never reaches.
   */
  registerLazy(registration: Registration): void {
    if (this.#lazy.has(registration.token)) return;
    this.#lazy.set(registration.token, {
      provider: registration.provider,
      module: '(override)',
      lazy: true,
    });
  }

  /** Every declared binding, in module import order, for eager resolution. */
  get eager(): readonly { scope: Scope; token: InjectionToken<unknown> }[] {
    const out: { scope: Scope; token: InjectionToken<unknown> }[] = [];
    for (const scope of this.#graph.ordered) {
      for (const [token, binding] of scope.own) {
        if (binding.lazy !== true) out.push({ scope, token });
      }
    }
    return out;
  }

  /** Construction-completion order, so dependencies come before their dependents. */
  get instances(): readonly unknown[] {
    return this.#order;
  }

  /**
   * Resolves from a scope's flattened view, self-binding a class nothing declares.
   *
   * A self-bound class lands in the **asking module's** `own` map rather than
   * anywhere shared, so an unlisted collaborator cannot leak between features - and
   * caching it there means repeated lookups share one instance.
   */
  get<T>(token: InjectionToken<T>, from?: Scope): T {
    const scope = from ?? this.#graph.root;
    const key = token as InjectionToken<unknown>;
    const binding = this.#bindingFor(key, scope);

    if (this.#instances.has(binding)) return this.#instances.get(binding) as T;

    const cycle = this.#building.findIndex(
      (entry) => entry.binding === binding,
    );
    if (cycle !== -1) {
      throw new CircularDependencyError(
        [...this.#building.slice(cycle), { binding, token: key }].map((entry) =>
          describeToken(entry.token),
        ),
      );
    }

    this.#building.push({ binding, token: key });
    try {
      return this.#instantiate(binding, scope) as T;
    } finally {
      this.#building.pop();
    }
  }

  /**
   * The escape hatch `app.get()` and the bootstrap use: the root scope's view first,
   * then any single scope that declares the token.
   *
   * Deliberately more permissive than constructor injection, which stays strict. This
   * is a debugging and wiring call rather than a dependency edge, and making a test
   * name the owning module would push container topology into every suite. Two scopes
   * declaring it differently is an error rather than a guess.
   */
  find<T>(token: InjectionToken<T>): T {
    const key = token as InjectionToken<unknown>;
    if (this.#graph.root.visible.has(key)) return this.get(token);

    const owners = this.#graph.ordered.filter((scope) => scope.own.has(key));
    if (owners.length > 1) {
      throw new AppError(
        `${describeToken(token)} is declared by ${owners
          .map((scope) => `"${scope.name}"`)
          .join(
            ' and ',
          )}, so app.get() cannot say which you mean. Resolve it from ` +
          'a provider in the module you want, or export exactly one of them.',
      );
    }

    const only = owners[0];
    // Only self-bind once nothing declares it. Checking `isCtor` first would quietly
    // construct a *third* instance in the root scope while two modules each already
    // hold their own, which is the opposite of what the caller asked for.
    return only === undefined ? this.get(token) : this.get(token, only);
  }

  async resolve<T>(token: InjectionToken<T>, from?: Scope): Promise<T> {
    const scope = from ?? this.#graph.root;
    const binding = this.#bindingFor(token as InjectionToken<unknown>, scope);
    if (this.#instances.has(binding)) {
      return this.#instances.get(binding) as T;
    }

    const inFlight = this.#settling.get(binding);
    if (inFlight) {
      const value = await inFlight;
      this.#settling.delete(binding);
      if (!this.#instances.has(binding)) this.#settle(binding, value);
      return this.#instances.get(binding) as T;
    }

    /**
     * The one loop here that genuinely cannot state its bound in the header, and the
     * reason is worth writing down rather than leaving a reader to trust it.
     *
     * `get` is synchronous. When it reaches a factory that returned a promise it parks
     * that promise in `#settling` and throws `PendingSignal`, because there is no way
     * to await from inside a sync call. Awaiting the signalled binding settles it into
     * `#instances`, and then the whole `get` is retried - from the top, since the
     * tokens resolved before the signal were discarded when the stack unwound.
     *
     * **It terminates**, and not by luck: every iteration awaits one binding and
     * settles it, `get` never signals a binding already settled, and the number of
     * bindings is finite. So the iteration count is at most the number of async
     * factories on this token's dependency path.
     */
    for (;;) {
      try {
        return this.get(token, scope);
      } catch (error) {
        if (!(error instanceof PendingSignal)) throw error;
        await this.#resolveBinding(error.binding, error.scope);
      }
    }
  }

  async #resolveBinding(binding: Binding, scope: Scope): Promise<void> {
    const inFlight = this.#settling.get(binding);
    if (inFlight === undefined) return;
    const value = await inFlight;
    this.#settling.delete(binding);
    if (!this.#instances.has(binding)) this.#settle(binding, value);
    void scope;
  }

  /**
   * The binding a token resolves to from `scope`, or a self-bound class.
   *
   * Resolution order is already baked into `scope.visible` - global, then imported
   * exports, then own, local winning - so this is one `Map.get`, which is what the
   * boot-time flattening buys.
   */
  #bindingFor(token: InjectionToken<unknown>, scope: Scope): Binding {
    const visible = scope.visible.get(token);
    if (visible) return visible;

    const lazy = this.#lazy.get(token);
    if (lazy) return lazy;

    if (isCtor(token)) {
      const created: Binding = {
        provider: { kind: 'class', ctor: token },
        module: scope.name,
      };
      scope.own.set(token, created);
      scope.visible.set(token, created);
      return created;
    }

    throw new AppError(unresolvableMessage(token, scope, this.#graph));
  }

  #instantiate(binding: Binding, scope: Scope): unknown {
    const { provider } = binding;
    if (provider.kind === 'value') return this.#settle(binding, provider.value);

    if (provider.kind === 'class') {
      // Resolved before the swap: argument resolution recurses through get(), which
      // must not see this class's own scope as the ambient one.
      const args = this.#constructorArgs(provider.ctor, scope);
      const previous = swapScope(this, scope);
      try {
        return this.#settle(
          binding,
          new (provider.ctor as Constructible)(...args),
        );
      } finally {
        swapScope(previous.injector, previous.scope);
      }
    }

    const deps = provider.deps.map((dep) => this.get(dep, scope));
    const result = provider.factory(...deps);
    if (result instanceof Promise) {
      this.#settling.set(binding, result);
      throw new PendingSignal(binding, scope);
    }
    return this.#settle(binding, result);
  }

  #constructorArgs(ctor: Ctor<unknown>, scope: Scope): readonly unknown[] {
    const deps = readDeps(ctor);

    // A declared parameter with nothing recorded for it means the transform never saw
    // this file. Constructing it anyway would pass `undefined` and fail later
    // somewhere unrelated, so the missing setup is reported here instead.
    if (deps.length === 0 && ctor.length > 0) {
      throw new AppError(missingTransformMessage(ctor.name, ctor.length));
    }

    return deps.map((dep, index) => {
      if (!isUnresolved(dep)) {
        try {
          return this.get(dep, scope);
        } catch (error) {
          // Re-raised naming the consumer, which is the difference between "cannot
          // resolve X" and "cannot resolve X for Y, which module Z declares".
          if (!(error instanceof AppError) || error instanceof PendingSignal) {
            throw error;
          }
          if (scope.visible.has(dep) || isCtor(dep)) throw error;
          throw new AppError(
            unresolvableMessage(dep, scope, this.#graph, ctor.name),
          );
        }
      }

      // The annotation is identical whether the name was imported with `import type`
      // or is an interface, so quoting it alone points at a line that is already
      // correct. Only the import-type case has a one-line fix, and it is the likely
      // one: `verbatimModuleSyntax` is on in the scaffold, which is exactly what makes
      // an editor offer to add `type`.
      const remedy =
        dep.typeOnly === undefined
          ? 'Replace the type with an abstract class, or bind it with token() ' +
            'and declare the parameter as that token.'
          : `${dep.typeOnly} is imported with \`import type\`, which erases it. ` +
            'Make it a value import.';

      throw new AppError(
        `${ctor.name} cannot be constructed: parameter ${index + 1} ` +
          `(${dep.unresolved}) names nothing that exists at runtime, so there is ` +
          `no token to resolve. ${remedy}`,
      );
    });
  }

  #settle(binding: Binding, value: unknown): unknown {
    this.#instances.set(binding, value);
    this.#order.push(value);
    return value;
  }
}
