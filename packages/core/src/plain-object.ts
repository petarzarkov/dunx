/**
 * A plain object: `{}`, `Object.create(null)`, or a parsed value. Anything with
 * its own prototype - a `Date`, a `Temporal.PlainDate`, a `Map`, a class
 * instance - is not one.
 *
 * The prototype check rather than `typeof === 'object' && !Array.isArray`, which
 * answers `true` for every class instance. `Bun.TOML.parse` is why this lives in
 * core: TOML has a first-class date type and Bun returns `Temporal.Instant` and
 * `Temporal.PlainDate` for it, both of which have zero own enumerable keys, so a
 * recursive merge that trusted the loose check replaced a date with `{}`.
 */
export const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
};
