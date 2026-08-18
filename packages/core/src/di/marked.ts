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
 * Every marked method on a prototype chain, most-derived first, names deduped.
 *
 * The marker technique is core's: a decorator defines a symbol-keyed property on
 * the method function, so nothing accumulates at class-definition time and there
 * is no ordering dependence. Reading it back means walking the chain, and three
 * packages had written that walk identically - `@dunx/http` twice, for routes and
 * for gateway handlers, and `@dunx/infra` once for `@JobHandler`. A scheduler's
 * `@Cron` would have been the fourth.
 *
 * Most-derived wins on a repeated name, so an undecorated override does not
 * inherit its base's marker. Dispatch still lands on the override, because every
 * caller binds the handler off the instance rather than off `value`.
 *
 * `Object.prototype` ends the walk, and `constructor` is skipped: neither can
 * carry a marker, and descending into `Object.prototype` would read every
 * built-in on every scan.
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
