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
  readonly imports?: readonly ModuleClass[];
  // Registered exactly like providers. Kept separate so an HTTP adapter can find
  // which instances to scan for routes; core itself only constructs them.
  readonly controllers?: readonly Ctor<unknown>[];
  readonly providers?: readonly ProviderEntry[];
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

const optionsOf = (module: ModuleClass): ModuleOptions => {
  // hasOwn, so a subclass of a module does not silently inherit its bindings.
  const options = Object.hasOwn(module, MODULE)
    ? (module as ModuleClass & Marked)[MODULE]
    : undefined;

  if (!options) {
    throw new AppError(
      `${module.name} is not a dunx module. Decorate it with @Module({ providers: [...] }).`,
    );
  }
  return options;
};

/**
 * Flattens the import graph, imports before importers so a module's dependencies
 * register first. Visiting each module once makes a diamond import register once
 * and a cycle terminate.
 */
export const collectModules = (root: ModuleClass): readonly ModuleClass[] => {
  const seen = new Set<ModuleClass>();
  const ordered: ModuleClass[] = [];

  const visit = (module: ModuleClass): void => {
    if (seen.has(module)) return;
    seen.add(module);
    for (const imported of optionsOf(module).imports ?? []) visit(imported);
    ordered.push(module);
  };

  visit(root);
  return ordered;
};

export const readModule = (module: ModuleClass): readonly Registration[] => {
  const options = optionsOf(module);
  const entries: readonly ProviderEntry[] = [
    ...(options.controllers ?? []),
    ...(options.providers ?? []),
  ];

  return entries.map((entry) =>
    typeof entry === 'function'
      ? { token: entry, provider: { kind: 'class', ctor: entry } }
      : entry,
  );
};

export const readControllers = (
  module: ModuleClass,
): readonly Ctor<unknown>[] => optionsOf(module).controllers ?? [];
