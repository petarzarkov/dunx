// The same technique as marker.ts: a decorator sets a symbol property on the
// function or the class it receives and returns it. Nothing accumulates at class
// definition time, so there is no ordering dependence and no cross-file leak.
// See docs/ARCHITECTURE.md, "Route discovery".
import type { Ctor } from '@dunx/core';
import type { Middleware } from '../server/middleware.js';

// Symbol.for for the two storage slots, so two copies of @dunx/http in one tree
// still read each other's records. The keys themselves are unique - see metaKey.
const META = Symbol.for('dunx.meta');
const GUARDS = Symbol.for('dunx.guards');

/** What a route's decorators resolved to, keyed by `MetaKey.id`. */
export type MetaRecord = ReadonlyMap<symbol, unknown>;

export interface MetaKey<T> {
  /** For error messages and debugging only. Identity is the symbol. */
  readonly name: string;
  readonly id: symbol;
  // Phantom. Never assigned - it exists so MetaKey<readonly string[]> and
  // MetaKey<boolean> are distinct types rather than both being { name, id }.
  readonly reads?: T;
}

/**
 * A fresh unique symbol per call, so two libraries that both name a key `roles`
 * never read each other's value. Two `metaKey('roles')` calls are two keys.
 */
export const metaKey = <T>(name: string): MetaKey<T> => ({
  name,
  id: Symbol(name),
});

interface MetaMarked {
  readonly [META]?: MetaRecord;
}

interface GuardMarked {
  readonly [GUARDS]?: readonly Ctor<Middleware>[];
}

/**
 * Copy-on-write, defined as an **own** property. The seed is read with plain
 * lookup, so a subclass starts from its base's record - but the base's Map is
 * never mutated, which is what keeps two subclasses of one base independent.
 */
const write = <T>(target: object, key: MetaKey<T>, value: T): void => {
  const record = new Map<symbol, unknown>((target as MetaMarked)[META]);
  record.set(key.id, value);
  Object.defineProperty(target, META, { value: record, configurable: true });
};

/**
 * The generic setter, valid on a method or on a class. `@Roles` and `@Public` are
 * thin wrappers over it; a user's own key needs nothing else.
 */
export const meta =
  <T>(key: MetaKey<T>, value: T) =>
  <F extends object>(target: F): F => {
    write(target, key, value);
    return target;
  };

export const ROLES: MetaKey<readonly string[]> = metaKey('roles');
export const PUBLIC: MetaKey<boolean> = metaKey('public');
export const HIDDEN: MetaKey<boolean> = metaKey('hidden');

export const Roles = (...roles: readonly string[]) => meta(ROLES, roles);
export const Public = () => meta(PUBLIC, true);

/**
 * Route, but not documented. Valid on a method or on a class.
 *
 * The motivating case is a handler mounted on a wildcard: `@dunx/auth` routes
 * `<basePath>/*` to Better Auth's own handler, which is real and has to be
 * routed, but `*` is not an OpenAPI path template - so documenting it produced an
 * invalid entry named after an internal class, next to the 45 paths
 * `betterAuthDocument` describes properly.
 *
 * It lives here rather than in `@dunx/openapi` because `@dunx/auth` must not
 * depend on the documentation package to say a route is undocumented, and this is
 * where the rest of the route metadata already is.
 */
export const ApiHidden = () => meta(HIDDEN, true);

/**
 * Guards are middleware, so they compose rather than override - which is why they
 * are not a `MetaKey`. Valid on a method or on a class.
 */
export const UseGuards =
  (...guards: readonly Ctor<Middleware>[]) =>
  <F extends object>(target: F): F => {
    const existing = (target as GuardMarked)[GUARDS] ?? [];
    // An own record means a second @UseGuards on the same target: decorators apply
    // bottom-up, so the later-applied one goes in front and the list reads
    // top-to-bottom. An inherited one means a subclass, whose guards run after
    // the base's - and defineProperty leaves the base's array untouched.
    const merged = Object.hasOwn(target, GUARDS)
      ? [...guards, ...existing]
      : [...existing, ...guards];
    Object.defineProperty(target, GUARDS, {
      value: merged,
      configurable: true,
    });
    return target;
  };

export const guardsOf = (target: object): readonly Ctor<Middleware>[] =>
  (target as GuardMarked)[GUARDS] ?? [];

export const metaOf = (target: object): MetaRecord | undefined =>
  (target as MetaMarked)[META];

/**
 * Later targets win, so `mergeMeta(klass, handler)` is the handler-then-class
 * resolution `RouteContext.get` exposes. Called once per route at boot.
 */
export const mergeMeta = (...targets: readonly object[]): MetaRecord => {
  const merged = new Map<symbol, unknown>();
  for (const target of targets) {
    const record = (target as MetaMarked)[META];
    if (record) for (const [id, value] of record) merged.set(id, value);
  }
  return merged;
};
