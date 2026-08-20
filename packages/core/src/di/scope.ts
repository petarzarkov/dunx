import { AppError } from './errors.js';
import {
  collectModules,
  isModuleExport,
  readModule,
  type ModuleClass,
  type ModuleRef,
  type ResolvedModule,
} from './module.js';
import type { ErasedProvider } from './provider.js';
import { describeToken, type Ctor, type InjectionToken } from './token.js';

/**
 * One provider, and the module that declared it.
 *
 * Identity matters: the instance cache is keyed on the binding object, not on the
 * token, which is what lets two modules each declare `UsersService` and get two
 * instances. Under the old flat container that was a boot error.
 */
export interface Binding {
  readonly provider: ErasedProvider;
  /** The declaring module's name, for every error message. */
  readonly module: string;
  /** Excluded from eager resolution. See `Injector.registerLazy`. */
  readonly lazy?: boolean;
}

/**
 * A module's resolution context: what it declares, and everything it can see.
 *
 * `visible` is **flattened at boot**. Walking an import chain per lookup would make
 * every construction O(depth); computing the closure once per module keeps
 * resolution the single `Map.get` it was when the container was flat, and moves the
 * cost to boot - which is the trade dunx makes everywhere else.
 */
export interface Scope {
  readonly name: string;
  readonly ref: ModuleRef;
  /** Tokens this module declares itself. Also where a self-bound class lands. */
  readonly own: Map<InjectionToken<unknown>, Binding>;
  /** Own bindings plus imported exports plus the global scope. Local wins. */
  readonly visible: Map<InjectionToken<unknown>, Binding>;
  readonly controllers: readonly Ctor<unknown>[];
  readonly middleware: readonly Ctor<unknown>[];
  /** What this module imports, kept so a resolution error can say "you do import it". */
  readonly imports: readonly ModuleRef[];
}

export interface ScopeGraph {
  /** Keyed on the module *reference*, so two configurations of one class differ. */
  readonly scopes: Map<ModuleRef, Scope>;
  /** Import order, so eager resolution still settles dependencies first. */
  readonly ordered: readonly Scope[];
  readonly root: Scope;
  /** Shadowing notices, reported by the caller so core stays logger-free. */
  readonly warnings: readonly string[];
}

const isToken = (
  entry: InjectionToken<unknown> | ModuleRef,
): entry is InjectionToken<unknown> => !isModuleExport(entry);

/**
 * A module's own bindings, and the one duplicate check that survives module scoping:
 * the same token twice *in one module* is still an error, because no reading of
 * scoping makes it meaningful.
 */
const ownBindings = (
  resolved: ResolvedModule,
): Map<InjectionToken<unknown>, Binding> => {
  const own = new Map<InjectionToken<unknown>, Binding>();
  for (const registration of readModule(resolved)) {
    if (own.has(registration.token)) {
      throw new AppError(
        `Duplicate binding for ${describeToken(registration.token)} in module ` +
          `"${resolved.name}": it is declared twice in the same providers list. A ` +
          "DynamicModule's own binding replaces the one its class's @Module " +
          'decorator declares, so this is two entries on the same side rather than ' +
          'a decorator and a forRoot() disagreeing.',
      );
    }
    own.set(registration.token, {
      provider: registration.provider,
      module: resolved.name,
    });
  }
  return own;
};

/**
 * Export sets, by iterating to a fixed point.
 *
 * `exports` may name a module, which re-exports whatever *that* module exports - so
 * `A exports B` and `B exports A` makes the two sets mutually dependent and naive
 * recursion overflows. It is not a real cycle: an export set is a union, union is
 * monotonic, so repeating the pass until nothing changes terminates in at most one
 * pass per module. Collapsing strongly-connected components first would be the same
 * answer with fewer passes, and is an optimisation rather than the design.
 */
const exportSets = (
  modules: readonly ResolvedModule[],
  own: Map<ModuleRef, Map<InjectionToken<unknown>, Binding>>,
): Map<ModuleRef, Map<InjectionToken<unknown>, Binding>> => {
  const sets = new Map<ModuleRef, Map<InjectionToken<unknown>, Binding>>(
    modules.map((m) => [m.ref, new Map()]),
  );

  for (let changed = true; changed;) {
    changed = false;
    for (const resolved of modules) {
      const set = sets.get(resolved.ref);
      const mine = own.get(resolved.ref);
      if (!set || !mine) continue;

      for (const entry of resolved.options.exports ?? []) {
        if (isToken(entry)) {
          // Own binding first; otherwise it is a re-export of something an import
          // exposes, which later passes fill in.
          const binding =
            mine.get(entry) ??
            (resolved.options.imports ?? [])
              .map((imported) => sets.get(imported)?.get(entry))
              .find((found) => found !== undefined);
          if (binding && !set.has(entry)) {
            set.set(entry, binding);
            changed = true;
          }
          continue;
        }
        for (const [token, binding] of sets.get(entry) ?? []) {
          if (!set.has(token)) {
            set.set(token, binding);
            changed = true;
          }
        }
      }
    }
  }
  return sets;
};

/**
 * Every token a module exports but does not own and cannot reach - the mistake that
 * would otherwise surface as a resolution failure in some *other* module, pointing at
 * the wrong place entirely.
 */
const assertExportsResolve = (
  modules: readonly ResolvedModule[],
  sets: Map<ModuleRef, Map<InjectionToken<unknown>, Binding>>,
): void => {
  for (const resolved of modules) {
    const set = sets.get(resolved.ref);
    for (const entry of resolved.options.exports ?? []) {
      if (!isToken(entry) || set?.has(entry) === true) continue;
      throw new AppError(
        `Module "${resolved.name}" exports ${describeToken(entry)}, but does not ` +
          'declare it and no module it imports exports it. Add it to this ' +
          "module's providers, or import the module that provides it.",
      );
    }
  }
};

/**
 * One module class registered twice, each registration binding the same token.
 *
 * `forRoot()` returns a fresh object per call, and a scope is keyed on the
 * reference - so two calls are two scopes with two of everything in them. Two
 * database connections, two schedule registries, two auth instances: each one
 * resolves, nothing errors, and half the app talks to the wrong copy.
 *
 * A warning rather than an error, because two registrations that bind **different**
 * tokens are a supported shape - `RedisModule.forRoot()` alongside
 * `RedisModule.forRoot({ name: 'cache' })` is two connections on purpose, and it is
 * silent here because the named one binds named tokens.
 */
const duplicateConfigurations = (
  modules: readonly ResolvedModule[],
  own: Map<ModuleRef, Map<InjectionToken<unknown>, Binding>>,
): readonly string[] => {
  const byClass = new Map<ModuleClass, ResolvedModule[]>();
  for (const resolved of modules) {
    const group = byClass.get(resolved.module);
    if (group) group.push(resolved);
    else byClass.set(resolved.module, [resolved]);
  }

  const warnings: string[] = [];
  for (const [klass, group] of byClass) {
    if (group.length < 2) continue;
    const counts = new Map<InjectionToken<unknown>, number>();
    for (const resolved of group) {
      for (const token of own.get(resolved.ref)?.keys() ?? []) {
        counts.set(token, (counts.get(token) ?? 0) + 1);
      }
    }
    const shared = [...counts]
      .filter(([, seen]) => seen > 1)
      .map(([token]) => describeToken(token));
    if (shared.length === 0) continue;
    warnings.push(
      `${klass.name} is registered ${group.length} times, and each registration ` +
        `binds ${shared.join(', ')} again. A configured module is keyed on the ` +
        'object forRoot() returned, and it returns a new one per call - so these ' +
        'are separate scopes holding separate instances. Call it once and share ' +
        'the result, or mark the module global: true so one registration reaches ' +
        'every scope.',
    );
  }
  return warnings;
};

/**
 * Builds one scope per module reference, with visibility flattened.
 *
 * Order of assembly inside `visible` is the resolution order: the global scope is
 * laid down first, imports over it, and the module's own bindings last - so **local
 * shadows imported**, which is the per-module rebinding that module scoping exists to
 * allow. Every shadow is reported as a warning rather than silently taken, because
 * "my override is not being used" is otherwise unexplainable; Nest is silent here and
 * it costs people hours.
 */
export const buildScopes = (root: ModuleRef): ScopeGraph => {
  const modules = collectModules(root);
  const own = new Map<ModuleRef, Map<InjectionToken<unknown>, Binding>>(
    modules.map((resolved) => [resolved.ref, ownBindings(resolved)]),
  );
  const sets = exportSets(modules, own);
  assertExportsResolve(modules, sets);

  const global = new Map<InjectionToken<unknown>, Binding>();
  for (const resolved of modules) {
    if (resolved.options.global !== true) continue;
    for (const [token, binding] of sets.get(resolved.ref) ?? []) {
      global.set(token, binding);
    }
  }

  const warnings: string[] = [...duplicateConfigurations(modules, own)];
  const scopes = new Map<ModuleRef, Scope>();
  const ordered: Scope[] = [];

  for (const resolved of modules) {
    const mine = own.get(resolved.ref) ?? new Map();
    const visible = new Map<InjectionToken<unknown>, Binding>(global);

    for (const imported of resolved.options.imports ?? []) {
      for (const [token, binding] of sets.get(imported) ?? []) {
        const already = visible.get(token);
        // Only a conflict when the bindings actually differ. Two imports exporting
        // the *same* binding is a diamond - A exports X and B re-exports A - and has
        // one answer, so it must stay silent.
        if (already && already !== binding && !global.has(token)) {
          warnings.push(
            `Module "${resolved.name}" imports ${describeToken(token)} from both ` +
              `"${already.module}" and "${binding.module}". The last import wins, so ` +
              'these are two separate instances. Import one, or declare it here.',
          );
        }
        visible.set(token, binding);
      }
    }
    for (const [token, binding] of mine) {
      const shadowed = visible.get(token);
      if (shadowed && shadowed.module !== binding.module) {
        warnings.push(
          `Module "${resolved.name}" declares ${describeToken(token)}, which module ` +
            `"${shadowed.module}" also exports to it. The local one wins, so these ` +
            'are two separate instances. Remove one, or ignore this if the ' +
            'rebinding is deliberate.',
        );
      }
      visible.set(token, binding);
    }

    const scope: Scope = {
      name: resolved.name,
      ref: resolved.ref,
      own: mine,
      visible,
      controllers: resolved.options.controllers ?? [],
      middleware: resolved.options.middleware ?? [],
      imports: resolved.options.imports ?? [],
    };
    scopes.set(resolved.ref, scope);
    ordered.push(scope);
  }

  const rootScope = scopes.get(root);
  if (!rootScope) {
    // collectModules always visits the root, so this is unreachable by construction
    // rather than a case to handle - it is here so the type is not widened.
    throw new AppError('The root module produced no scope.');
  }

  return { scopes, ordered, root: rootScope, warnings };
};

/**
 * The message for a token nothing visible binds, answered from the whole graph
 * because the graph is known at boot.
 *
 * `exports` reintroduces the most complained-about error in the Nest ecosystem, so
 * this is the place dunx has to be strictly better rather than merely equivalent: it
 * says which module declares the token, whether it is imported, whether it is
 * exported, and the line to add.
 */
export const unresolvableMessage = (
  token: InjectionToken<unknown>,
  scope: Scope,
  graph: ScopeGraph,
  consumer?: string,
): string => {
  const name = describeToken(token);
  const asking = consumer === undefined ? '' : ` for ${consumer}`;
  const head = `Cannot resolve ${name}${asking} in module "${scope.name}".`;

  const declaring = graph.ordered.filter((other) => other.own.has(token));
  if (declaring.length === 0) {
    return (
      `${head} Nothing in the module graph declares it. Bind it with provide() in a ` +
      "module's providers, and export it if the consumer is in a different module."
    );
  }

  const imported = new Set(scope.imports);
  const names = declaring.map((other) => `"${other.name}"`).join(', ');
  const isImported = declaring.some((other) => imported.has(other.ref));

  return isImported
    ? `${head} ${names} declares it and "${scope.name}" imports that module, but it ` +
        `does not export ${name}. Add ${name} to that module's exports, or move the ` +
        `provider into "${scope.name}".`
    : `${head} ${names} declares it, but "${scope.name}" does not import it. Add that ` +
        `module to "${scope.name}"'s imports, or give it global: true.`;
};
