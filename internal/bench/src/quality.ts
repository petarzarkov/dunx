/**
 * When a row's failures stop being a blip and become the row.
 *
 * The rule used to be "any non-2xx invalidates it", which is what
 * `internal/bench/README.md` had said for a long time and what `report.ts` began
 * enforcing when the io scenario arrived. Enforcing it exposed that it is the
 * wrong rule in both directions at once:
 *
 * - Two Node subjects that died mid-run were recorded at 560,964 req/s of pure
 *   connection failures and, before the rule, sorted above raw `Bun.serve`.
 * - Django answered **one** non-2xx out of 38,909 on the io scenario - 0.0026% -
 *   and lost its ratio for it, which reads as a broken measurement rather than a
 *   measurement with one blip in it.
 *
 * A rate separates those two, where a count cannot. Anything at or under the
 * floor is a real number with a footnote; anything above it is a row nobody can
 * compare, and it is unranked and shown last.
 *
 * The count is always reported, at every rate. This decides how a row is
 * *ranked*, never whether the reader is told.
 */

/** One in a thousand. Measured failures have been either ~0.003% or above 25%. */
export const BAD_RATE_FLOOR = 0.001;

export const badRate = (bad: number, requests: number): number => {
  if (bad === 0) return 0;
  // A row that made no requests at all is nothing but failure, whatever the
  // count says, and dividing by zero would rank it first.
  return requests === 0 ? 1 : bad / requests;
};

/** True when the failures are too many for the row to be ranked. */
export const invalidates = (bad: number, requests: number): boolean =>
  badRate(bad, requests) > BAD_RATE_FLOOR;

/** `0.0026%`, for a footnote next to a row that is still ranked. */
export const formatBadRate = (bad: number, requests: number): string =>
  `${(badRate(bad, requests) * 100).toFixed(4)}%`;
