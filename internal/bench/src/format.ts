/**
 * The number formats every table in this harness prints.
 *
 * There were five copies of `int` - `report.ts`, `readme-tables.ts`,
 * `logging-tables.ts`, `validation-tables.ts` and `drivers-tables.ts` - and two of
 * `signed`. A locale or rounding change to one of them would have left the other
 * four printing something else, in outputs a reader compares side by side.
 */
export const int = (value: number): string =>
  Math.round(value).toLocaleString('en-US');

export const dec = (value: number, places = 3): string => value.toFixed(places);

/** A delta, with a real minus sign rather than a hyphen. */
export const signed = (value: number, places = 2, unit = ''): string =>
  `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(places)}${unit}`;
