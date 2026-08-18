/**
 * `Bun.cron`'s options argument, which the runtime accepts and bun-types does not
 * declare.
 *
 * On 1.3.14 the declarations are `(schedule, handler): CronJob` and
 * `parse(expression, relativeDate?): Date | null`, with no third parameter on
 * either, while the runtime takes one and **ignores** it. Both halves matter: the
 * missing declaration is why this file exists, and the ignoring is why
 * `supportsTz()` probes rather than trusting the call to have worked.
 *
 * Narrowed here, once, rather than cast at every call site. Delete this file when
 * bun-types declares the option.
 */

export interface CronCallOptions {
  readonly tz?: string;
}

/** The parts of `Bun.cron`'s handle this uses. */
export interface CronHandle {
  stop(): unknown;
  ref(): unknown;
  unref(): unknown;
}

type CronWithOptions = (
  schedule: string,
  handler: () => unknown,
  options?: CronCallOptions,
) => CronHandle;

type ParseWithOptions = (
  expression: string,
  relativeDate?: Date | number,
  options?: CronCallOptions,
) => Date | null;

export const cron = Bun.cron as unknown as CronWithOptions;
export const parseCron = Bun.cron.parse as unknown as ParseWithOptions;
