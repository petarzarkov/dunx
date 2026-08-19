/**
 * `Bun.cron`'s options argument, which the runtime accepts and bun-types does not
 * declare.
 *
 * On 1.3.14 the declarations are `(schedule, handler): CronJob`,
 * `(path, schedule, title): Promise<void>` and
 * `parse(expression, relativeDate?): Date | null`. **None of the three has a third
 * options parameter**, while the runtime takes one on the first and the last and
 * ignores it. That is the whole reason for the casts below: there is no overload to
 * satisfy, so a call passing `{ tz }` cannot typecheck without one.
 *
 * What is *not* cast away is everything Bun does declare. `Bun.CronWithAutocomplete`
 * carries the alias union (`@daily`, `@hourly`, month and weekday names) and
 * `Bun.CronJob` is the handle, so both are used rather than restated: an earlier
 * version of this file typed the schedule as `string` and the handle as a local
 * interface, which threw the aliases and the chainable handle away for nothing.
 *
 * Delete this file when bun-types declares the option.
 */

export interface CronCallOptions {
  /** IANA zone id. Ignored by 1.3.14; see `capability.ts`. */
  readonly tz?: string;
}

type CronWithOptions = (
  schedule: Bun.CronWithAutocomplete,
  handler: () => unknown,
  options?: CronCallOptions,
) => Bun.CronJob;

type ParseWithOptions = (
  expression: Bun.CronWithAutocomplete,
  relativeDate?: Date | number,
  options?: CronCallOptions,
) => Date | null;

export const cron = Bun.cron as unknown as CronWithOptions;
export const parseCron = Bun.cron.parse as unknown as ParseWithOptions;
