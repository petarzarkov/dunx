import type { ProviderEntry } from './module.js';
import type { Ctor, InjectionToken } from './token.js';

/**
 * A method a decorator marked, found by walking a prototype chain.
 *
 * `value` is the function the decorator wrote onto, not the member read off the
 * instance. Any further marker a second decorator left is on that object, and it
 * is the only place the metadata can have come from.
 */
export interface MarkedMethod<M> {
  readonly name: string;
  readonly meta: M;
  readonly value: object;
}

/**
 * Every marked method on a prototype chain, most-derived first, names deduped. A
 * decorator defines a symbol-keyed property on the method function, so nothing
 * accumulates at class-definition time; three packages had written this walk
 * identically before it moved here.
 *
 * Most-derived wins on a repeated name, so an undecorated override does not
 * inherit its base's marker. Dispatch still lands on the override, since callers
 * bind off the instance.
 *
 * `Object.prototype` ends the walk and `constructor` is skipped.
 */
export const markedMethods = <M>(
  start: object | null,
  metaOf: (value: unknown) => M | undefined,
): readonly MarkedMethod<M>[] => {
  const found: MarkedMethod<M>[] = [];
  const seen = new Set<string>();

  for (
    let proto = start;
    proto !== null && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const [name, descriptor] of Object.entries(
      Object.getOwnPropertyDescriptors(proto),
    )) {
      if (name === 'constructor' || seen.has(name)) continue;

      const meta = metaOf(descriptor.value);
      if (meta === undefined) continue;

      seen.add(name);
      found.push({ name, meta, value: descriptor.value as object });
    }
  }

  return found;
};

/**
 * The class a `providers` entry would construct, or nothing for a value or factory
 * provider - neither is a discovery candidate, since there is no prototype chain
 * to read until it is built and building it to find out is the ordering trap the
 * marker technique avoids.
 *
 * Here because three packages walk `providers` looking for marked methods.
 */
export const classOf = (
  entry: ProviderEntry,
): { token: InjectionToken<unknown>; ctor: Ctor<unknown> } | undefined => {
  if (typeof entry === 'function') return { token: entry, ctor: entry };
  return entry.provider.kind === 'class'
    ? { token: entry.token, ctor: entry.provider.ctor }
    : undefined;
};
