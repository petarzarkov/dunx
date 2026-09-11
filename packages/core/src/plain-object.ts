/**
 * A plain object: `{}` or `Object.create(null)`. A `Date`, a `Temporal.PlainDate`,
 * a `Map` or a class instance is not one, which `typeof === 'object'` gets wrong:
 * `Bun.TOML.parse` returns `Temporal` values with zero own keys, and a merge that
 * trusted the loose check wrote `{}` over a date.
 */
export const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
};
