import { AppError } from './errors.js';
import type { Registration } from './provider.js';
import type { Ctor } from './token.js';

// Symbol.for, not Symbol: two copies of @dunx/core in a dependency tree still
// agree on the key. Same marker technique as route discovery — no accumulator.
const MODULE = Symbol.for('dunx.module');

/** A bare class is shorthand for binding it to itself. */
export type ProviderEntry = Ctor<unknown> | Registration;

export type ModuleClass = abstract new (...args: never[]) => object;

export interface ModuleOptions {
  // Traversal only. Importing a module registers its providers into the same flat
  // container — it does not create a visibility boundary.
  readonly imports?: readonly ModuleRef[];
  // Registered exactly like providers. Kept separate so an HTTP adapter can find
  // which instances to scan for routes; core itself only constructs them.
  readonly controllers?: readonly Ctor<unknown>[];
  readonly providers?: readonly ProviderEntry[];
}

/**
 * A configured module — what a `static forRoot(options)` returns. The
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

/** A module reference flattened to the registrations it contributes. */
export interface ResolvedModule {
  readonly module: ModuleClass;
  /** Where the duplicate-binding error gets "bound by module X and module Y". */
  readonly name: string;
  readonly options: ModuleOptions;
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
      options: {
        imports: concat(declared?.imports, ref.imports),
        controllers: concat(declared?.controllers, ref.controllers),
        providers: concat(declared?.providers, ref.providers),
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
  return { module: ref, name: ref.name, options };
};

/**
 * Flattens the import graph, imports before importers so a module's dependencies
 * register first.
 *
 * A bare class is visited once however many modules import it, which is what makes
 * a diamond import register once and a cycle terminate. Two *different*
 * configurations of the same module are deliberately not deduped — both register,
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
