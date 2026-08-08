import { AppError } from './errors.js';
import type { Registration } from './provider.js';
import { token, type Ctor, type InjectionToken, type Token } from './token.js';

// Symbol.for, not Symbol: two copies of @dunx/core in a dependency tree still
// agree on the key. Same marker technique as route discovery - no accumulator.
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
  // Registered exactly like providers. Kept separate so an HTTP adapter can find
  // which instances to scan for routes; core itself only constructs them.
  readonly controllers?: readonly Ctor<unknown>[];
  readonly providers?: readonly ProviderEntry[];
  /**
   * This module's public surface. A token listed here is resolvable by any module
   * that imports this one; everything else stays private to it.
   *
   * A `ModuleRef` re-exports whatever that module exports, which is what makes a
   * facade module possible - `InfraModule` importing and re-exporting `DbModule`
   * means an importer of `InfraModule` sees the database without naming it.
   *
   * **Absent means nothing is exported.** A module with providers and no `exports`
   * is fully private, which is the point of the boundary.
   */
  readonly exports?: readonly (InjectionToken<unknown> | ModuleRef)[];
  /**
   * Publishes this module's `exports` to every scope in the app, with no import
   * needed. Its private providers stay private.
   *
   * A field rather than a separate `@Global()` decorator: dunx configures modules
   * through one options object, and a `DynamicModule` would need the field anyway,
   * so a decorator would be a second spelling for one idea.
   */
  readonly global?: boolean;
  /**
   * Middleware applied to the routes **this module's controllers declare**, and to
   * nothing else. Resolved from this module's scope, so it can inject providers the
   * module keeps private.
   *
   * There is no inheritance: importing a module never changes the request path of
   * the importer's own routes. Middleware that really is app-wide stays app-wide.
   *
   * One field rather than `middleware` plus `guards`, because a guard here is
   * middleware that throws - the same "one extension point, not five" decision the
   * global chain rests on.
   */
  readonly middleware?: readonly Ctor<unknown>[];
}

/**
 * A configured module - what a `static forRoot(options)` returns. The
 * registrations it carries are merged with whatever the class's own `@Module`
 * decorator declares, so a module can have a static core plus configured extras.
 *
 * There is no separate `forRootAsync`: because dunx resolves eagerly and awaits
 * async factories before any constructor runs, an asynchronously configured
 * module is just one whose options token is bound with `useFactory`.
 */
export interface DynamicModule extends ModuleOptions {
  readonly module: ModuleClass;
}

/** Either a decorated class or a configured module. */
export type ModuleRef = ModuleClass | DynamicModule;

/**
 * The reference `AppFactory.create` was handed, bound into the global scope so a
 * provider can read the module graph it is itself part of.
 *
 * It exists for one shape of consumer: something mounted **inside** a running app
 * that has to report on that app - `@dunx/dashboard` is the case that forced it.
 * The graph readers all take a `ModuleRef`, and a middleware has no other way to
 * name the root; passing it back in through an option would mean an app listing
 * its own root module inside its own `imports`.
 *
 * Reading it is not booting anything: the readers walk prototypes and construct
 * nothing, which is the guarantee `providersOf` and `routesOf` are built on.
 */
export const ROOT_MODULE: Token<ModuleRef> =
  token<ModuleRef>('dunx.root-module');

/** A module reference flattened to the registrations it contributes. */
export interface ResolvedModule {
  readonly module: ModuleClass;
  /** Names the module in a duplicate-binding or visibility error. */
  readonly name: string;
  readonly options: ModuleOptions;
  /**
   * The reference this was resolved from, so the visibility graph can key on
   * identity: two different configurations of one class are two scopes, and the
   * class alone cannot tell them apart.
   */
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
 *
 * Deliberately **not** {@link isModuleRef}: that one demands the `@Module` marker,
 * and a `DynamicModule` from a static factory usually names a class that carries no
 * decorator at all - `MailerModule`, `DbModule`, `AuthModule`, every configured
 * module in `@dunx/infra`. Requiring the marker here rejected exactly the facade
 * re-export the feature exists for, and reported it as an unresolvable token named
 * `undefined`.
 *
 * The structural test is enough because the alternatives are disjoint: a `Token` is
 * `{ description }` with no `module`, and an abstract-class token is a function,
 * which the decorated-class branch already answers.
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

const concat = <T>(
  left: readonly T[] | undefined,
  right: readonly T[] | undefined,
): readonly T[] => [...(left ?? []), ...(right ?? [])];

const resolveRef = (ref: ModuleRef): ResolvedModule => {
  if (isDynamic(ref)) {
    const declared = declaredOptions(ref.module);
    return {
      module: ref.module,
      name: ref.module.name,
      ref,
      options: {
        imports: concat(declared?.imports, ref.imports),
        controllers: concat(declared?.controllers, ref.controllers),
        providers: concat(declared?.providers, ref.providers),
        exports: concat(declared?.exports, ref.exports),
        middleware: concat(declared?.middleware, ref.middleware),
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
  return { module: ref, name: ref.name, ref, options };
};

/**
 * Flattens the import graph, imports before importers so a module's dependencies
 * register first.
 *
 * A bare class is visited once however many modules import it, which is what makes
 * a diamond import register once and a cycle terminate. Two *different*
 * configurations of the same module are deliberately not deduped - both register,
 * so the duplicate-token check reports them by name instead of silently keeping
 * whichever was reached first.
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
 * Whether a value is something `collectModules` could be handed - a `@Module` class
 * or a configured module from a static factory.
 *
 * `Object.hasOwn`, matching `declaredOptions`: a subclass of a module does not
 * inherit its bindings, so it is not a module either.
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
 * The root module among a loaded file's exports.
 *
 * Every tool that takes an entry path needs this and none of them can guess a
 * name: `bunx dunx-openapi` and `bunx @dunx/mcp` both required `default` or `root`,
 * while `@dunx/create-app`'s template - and every example in this repo - ends
 * `export class AppModule {}` and nothing else. So the first thing anyone would try
 * failed on a freshly scaffolded app. `@Module` leaves a marker, so the root can be
 * *recognised* rather than named.
 *
 * `root` and `default` still win when present, so a file that also exports feature
 * modules resolves to the one it nominated rather than reporting a tie. `named` is
 * the explicit override for a file that nominates nothing and declares several.
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
