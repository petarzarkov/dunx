import type { Ctor, InjectionToken } from './token.js';

/**
 * Written by `@dunx/transform` as a thunk on the class itself. `Symbol.for`, so two
 * copies of `@dunx/core` in one dependency tree still agree on the key.
 */
const DEPS = Symbol.for('dunx.deps');

/** A constructor parameter whose type named nothing that exists at runtime. */
export interface UnresolvedDep {
  readonly unresolved: string;
}

export type DepEntry = InjectionToken<unknown> | UnresolvedDep;

interface DepsMarked {
  readonly [DEPS]?: () => readonly DepEntry[];
}

export type Constructible = new (...args: readonly unknown[]) => unknown;

export const isUnresolved = (entry: DepEntry): entry is UnresolvedDep =>
  typeof entry === 'object' && entry !== null && 'unresolved' in entry;

/**
 * Plain prototype-chain lookup rather than `Object.hasOwn`: a subclass that
 * declares no constructor of its own inherits its base's, so it must inherit the
 * base's dependencies with it. A subclass that does declare one gets its own
 * record from the compiler, which shadows the base's.
 *
 * Calling the thunk here — not at class-definition time — is what lets a
 * dependency be declared later in the file, or across a circular import, without
 * a temporal-dead-zone crash.
 */
export const readDeps = (ctor: Ctor<unknown>): readonly DepEntry[] => {
  const thunk = (ctor as DepsMarked)[DEPS];
  return typeof thunk === 'function' ? thunk() : [];
};
