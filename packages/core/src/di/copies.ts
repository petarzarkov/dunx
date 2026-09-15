import { AppError } from './errors.js';

/**
 * Collects one entry per loaded copy of this module. `Symbol.for`, so a second
 * copy of `@dunx/core` writes into the same set rather than starting its own -
 * which is the whole measurement.
 */
const COPIES = Symbol.for('dunx.core.copies');

const registry = ((): Set<string> => {
  const globals = globalThis as unknown as Record<symbol, unknown>;
  const existing = globals[COPIES];
  if (existing instanceof Set) return existing as Set<string>;
  const created = new Set<string>();
  globals[COPIES] = created;
  return created;
})();

// The URL, not a per-evaluation object: `bun --hot` reruns this, an install moves it.
registry.add(import.meta.url);

export const loadedCoreCopies = (): number => registry.size;

/**
 * Two copies is a correctness problem, not a duplication one: a token is a
 * class, so each copy has its own `Logger`, and a binding made against one is
 * invisible to the other. The second self-binds and is constructed - `abstract`
 * is erased - so the injected object has none of the methods, and nothing fails
 * until something calls one, in whichever package injected it.
 *
 * Only copies carrying this file register, so a tree mixing one with a version
 * released before it counts one and says nothing.
 */
export const assertOneCore = (copies: number = loadedCoreCopies()): void => {
  if (copies < 2) return;

  throw new AppError(
    `${copies} copies of @dunx/core are loaded in this process. A token is a ` +
      'class, so each copy has its own Logger, its own RequestContext and its ' +
      'own everything else: a binding made against one is invisible to the ' +
      'other, and the container silently injects an instance with no methods ' +
      'on it.\n\n' +
      'Run `bun why @dunx/core` to find the second copy. A package that lists ' +
      '@dunx/core under dependencies instead of peerDependencies is the usual ' +
      'cause - a published dunx package peer-depends, so the app owns the only ' +
      'copy.',
  );
};
