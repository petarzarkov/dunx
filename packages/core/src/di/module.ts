import { AppError } from './errors.js';
import type { Registration } from './provider.js';
import { token, type Ctor, type InjectionToken, type Token } from './token.js';

// Symbol.for, so two copies of @dunx/core in one tree agree on the key.
const MODULE = Symbol.for('dunx.module');

/** A bare class is shorthand for binding it to itself. */
export type ProviderEntry = Ctor<unknown> | Registration;

export type ModuleClass = abstract new (...args: never[]) => object;

export interface ModuleOptions {
  /**
   * The modules this one may resolve from. A module sees its own providers plus
   * whatever its imports `export`, and nothing else.
   */
  readonly imports?: readonly ModuleRef[];
  // Registered like providers, kept separate so an HTTP adapter can find which
  // instances to scan for routes.
  readonly controllers?: readonly Ctor<unknown>[];
  readonly providers?: readonly ProviderEntry[];
  /**
   * This module's public surface. A `ModuleRef` here re-exports whatever that
   * module exports, which is what makes a facade module possible.
   *
   * Absent means nothing is exported.
   */
  readonly exports?: readonly (InjectionToken<unknown> | ModuleRef)[];
  /**
   * Publishes this module's `exports` to every scope, with no import needed. Its
   * private providers stay private. A field rather than a `@Global()` decorator,
   * which a `DynamicModule` would need anyway.
   */
  readonly global?: boolean;
  /**
   * Middleware applied to the routes this module's controllers declare, and to
   * nothing else. Resolved from this module's scope, so it can inject providers
   * the module keeps private. There is no inheritance: importing a module never
   * changes the importer's own routes. A guard here is middleware that throws.
   */
  readonly middleware?: readonly Ctor<unknown>[];
}

/**
 * What a `static forRoot(options)` returns. Merged with whatever the class's own
 * `@Module` declares, so a module can have a static core plus configured extras.
 * An asynchronously configured module is one whose options token is bound with
 * `useFactory`, since dunx awaits async factories before any constructor runs.
 */
export interface DynamicModule extends ModuleOptions {
  readonly module: ModuleClass;
}

/** Either a decorated class or a configured module. */
export type ModuleRef = ModuleClass | DynamicModule;

/**
 * The reference `AppFactory.create` was handed, bound globally so a provider can
 * read the module graph it is part of. For something mounted inside a running app
 * that has to report on it, such as `@dunx/dashboard`: the graph readers take a
 * `ModuleRef` and a middleware has no other way to name the root.
 */
export const ROOT_MODULE: Token<ModuleRef> =
  token<ModuleRef>('dunx.root-module');

/** A module reference flattened to the registrations it contributes. */
export interface ResolvedModule {
  readonly module: ModuleClass;
  /** Names the module in a duplicate-binding or visibility error. */
  readonly name: string;
  readonly options: ModuleOptions;
  /** The reference this was resolved from, so the visibility graph keys on
   * identity: two configurations of one class are two scopes. */
  readonly ref: ModuleRef;
}

interface Marked {
  readonly [MODULE]?: ModuleOptions;
}

export const Module =
  (options: ModuleOptions) =>
  <T extends ModuleClass>(target: T): T => {
    Object.defineProperty(target, MODULE, { value: options });
    return target;
  };

// A class is a function; a configured module is a plain object.
const isDynamic = (ref: ModuleRef): ref is DynamicModule =>
  typeof ref === 'object';

/**
 * Whether an `exports` entry is a module reference rather than an injection token.
 * Not {@link isModuleRef}, which demands the `@Module` marker: a `DynamicModule`
 * from a static factory usually names an undecorated class, so requiring the
 * marker rejected the facade re-export this exists for.
 *
 * The structural test suffices because the alternatives are disjoint.
 */
export const isModuleExport = (
  entry: InjectionToken<unknown> | ModuleRef,
): entry is ModuleRef => {
  if (typeof entry === 'function') return Object.hasOwn(entry, MODULE);
  return (
    'module' in entry && typeof (entry as DynamicModule).module === 'function'
  );
};

// hasOwn, so a subclass of a module does not silently inherit its bindings.
const declaredOptions = (module: ModuleClass): ModuleOptions | undefined =>
  Object.hasOwn(module, MODULE)
    ? (module as ModuleClass & Marked)[MODULE]
    : undefined;

/**
 * A declared list and a configured one joined without duplicating, which is what
 * makes `@Module` and a `static forRoot()` on one class safe to combine. A plain
 * concatenation registered the decorator's entries twice: two scopes of one
 * module, and two of everything in them.
 */
const union = <T>(
  declared: readonly T[] | undefined,
  configured: readonly T[] | undefined,
): readonly T[] => {
  if (declared === undefined || declared.length === 0) return configured ?? [];
  if (configured === undefined || configured.length === 0) return declared;
  const claimed = new Set(configured);
  return [...declared.filter((entry) => !claimed.has(entry)), ...configured];
};

const tokenOf = (entry: ProviderEntry): InjectionToken<unknown> =>
  typeof entry === 'function' ? entry : entry.token;

/**
 * The same join for providers, keyed on the token. `forRoot()`'s binding wins, so
 * a decorator can hold the default and the factory the override, instead of the
 * pair being a duplicate-binding error.
 */
const unionProviders = (
  declared: readonly ProviderEntry[] | undefined,
  configured: readonly ProviderEntry[] | undefined,
): readonly ProviderEntry[] => {
  if (declared === undefined || declared.length === 0) return configured ?? [];
  if (configured === undefined || configured.length === 0) return declared;
  const claimed = new Set(configured.map(tokenOf));
  return [
    ...declared.filter((entry) => !claimed.has(tokenOf(entry))),
    ...configured,
  ];
};

/**
 * An `exports` entry naming a module class becomes the configured module of that
 * class this module imports. Writing the class used to fail as an unresolvable
 * token blamed on this module, so it resolves to what was imported under it.
 */
type ExportEntry = InjectionToken<unknown> | ModuleRef;

const resolveModuleExports = (
  exports: readonly ExportEntry[] | undefined,
  imports: readonly ModuleRef[] | undefined,
  providers: readonly ProviderEntry[],
): readonly ExportEntry[] | undefined => {
  if (exports === undefined || imports === undefined) return exports;
  if (exports.length === 0 || imports.length === 0) return exports;
  const own = new Set(providers.map(tokenOf));

  return exports.map((entry) => {
    if (typeof entry !== 'function') return entry;
    // An abstract-class token this module declares is a token however module-like
    // it looks, so a provider wins over the rewrite.
    if (own.has(entry as InjectionToken<unknown>)) return entry;
    // A bare import is already the reference the scope is keyed on.
    return (
      imports.find(
        (imported) => isDynamic(imported) && imported.module === entry,
      ) ?? entry
    );
  });
};

const resolveRef = (ref: ModuleRef): ResolvedModule => {
  if (isDynamic(ref)) {
    const declared = declaredOptions(ref.module);
    const imports = union(declared?.imports, ref.imports);
    const providers = unionProviders(declared?.providers, ref.providers);
    return {
      module: ref.module,
      name: ref.module.name,
      ref,
      options: {
        imports,
        controllers: union(declared?.controllers, ref.controllers),
        providers,
        exports:
          resolveModuleExports(
            union(declared?.exports, ref.exports),
            imports,
            providers,
          ) ?? [],
        middleware: union(declared?.middleware, ref.middleware),
        global: declared?.global === true || ref.global === true,
      },
    };
  }

  const options = declaredOptions(ref);
  if (!options) {
    throw new AppError(
      `${ref.name} is not a dunx module. Decorate it with ` +
        '@Module({ providers: [...] }), or import a configured one from a static ' +
        `factory such as ${ref.name}.forRoot().`,
    );
  }
  const resolvedExports = resolveModuleExports(
    options.exports,
    options.imports,
    options.providers ?? [],
  );
  return {
    module: ref,
    name: ref.name,
    ref,
    options:
      resolvedExports === options.exports || resolvedExports === undefined
        ? options
        : { ...options, exports: resolvedExports },
  };
};

/**
 * Flattens the import graph, imports before importers. A bare class is visited
 * once however many modules import it, so a diamond registers once and a cycle
 * terminates. Two different configurations of one module are not deduped, so the
 * duplicate-token check reports them by name.
 */
export const collectModules = (root: ModuleRef): readonly ResolvedModule[] => {
  const seen = new Set<ModuleRef>();
  const seenClasses = new Set<ModuleClass>();
  const ordered: ResolvedModule[] = [];

  const visit = (ref: ModuleRef): void => {
    if (seen.has(ref)) return;
    seen.add(ref);

    if (!isDynamic(ref)) {
      if (seenClasses.has(ref)) return;
      seenClasses.add(ref);
    }

    const resolved = resolveRef(ref);
    for (const imported of resolved.options.imports ?? []) visit(imported);
    ordered.push(resolved);
  };

  visit(root);
  return ordered;
};

export const readModule = (
  resolved: ResolvedModule,
): readonly Registration[] => {
  const entries: readonly ProviderEntry[] = [
    ...(resolved.options.controllers ?? []),
    ...(resolved.options.providers ?? []),
  ];

  return entries.map((entry) =>
    typeof entry === 'function'
      ? { token: entry, provider: { kind: 'class', ctor: entry } }
      : entry,
  );
};

export const readControllers = (
  resolved: ResolvedModule,
): readonly Ctor<unknown>[] => resolved.options.controllers ?? [];

/**
 * Whether a value is something `collectModules` could be handed. `Object.hasOwn`,
 * matching `declaredOptions`: a subclass does not inherit its bindings.
 */
export const isModuleRef = (value: unknown): value is ModuleRef => {
  if (typeof value === 'function') return Object.hasOwn(value, MODULE);
  return (
    typeof value === 'object' &&
    value !== null &&
    'module' in value &&
    typeof value.module === 'function' &&
    Object.hasOwn(value.module, MODULE)
  );
};

export type RootModuleResult =
  | { readonly kind: 'found'; readonly root: ModuleRef }
  | { readonly kind: 'none' }
  | { readonly kind: 'ambiguous'; readonly names: readonly string[] };

/**
 * The root module among a loaded file's exports. Tools used to require `default`
 * or `root`, which failed on a freshly scaffolded app ending
 * `export class AppModule {}`; `@Module` leaves a marker, so the root is
 * recognised rather than named.
 *
 * `root` and `default` still win when present. `named` is the explicit override.
 */
export const findRootModule = (
  exports: Readonly<Record<string, unknown>>,
  named?: string,
): RootModuleResult => {
  if (named !== undefined) {
    const picked = exports[named];
    return isModuleRef(picked)
      ? { kind: 'found', root: picked }
      : { kind: 'none' };
  }

  for (const key of ['root', 'default']) {
    const value = exports[key];
    if (isModuleRef(value)) return { kind: 'found', root: value };
  }

  const names = Object.keys(exports).filter((key) => isModuleRef(exports[key]));
  const only = names[0];
  if (names.length === 1 && only !== undefined) {
    return { kind: 'found', root: exports[only] as ModuleRef };
  }
  return names.length === 0 ? { kind: 'none' } : { kind: 'ambiguous', names };
};
