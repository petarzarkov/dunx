// Symbol.for, so two copies of @dunx/infra in a tree still agree on the key. The
// marker goes on the method function itself - nothing accumulates at class
// definition time, so there is no ordering dependence and no cross-file leak.
// Same technique as route, gateway and job discovery.
const SCHEDULE = Symbol.for('dunx.schedule');

export const ScheduleKind = Object.freeze({
  CRON: 'cron',
  INTERVAL: 'interval',
  ONCE: 'once',
} as const);

export type ScheduleKind = (typeof ScheduleKind)[keyof typeof ScheduleKind];

/**
 * The named schedules `Bun.cron` understands, as a frozen object rather than a TS
 * `enum` - see CLAUDE.md.
 *
 * All seven parse at runtime, verified against 1.3.14. They are also in
 * `Bun.CronWithAutocomplete`, which is what `@Cron` takes, so a literal
 * `'@daily'` is accepted and offered by an editor without going through this. This
 * exists for the case a literal cannot serve: a value to hold in a config object or
 * pass through a variable.
 */
export const CronExpression = Object.freeze({
  YEARLY: '@yearly',
  ANNUALLY: '@annually',
  MONTHLY: '@monthly',
  WEEKLY: '@weekly',
  DAILY: '@daily',
  MIDNIGHT: '@midnight',
  HOURLY: '@hourly',
} as const);

export type CronExpression =
  (typeof CronExpression)[keyof typeof CronExpression];

/**
 * What happens when a run is still going at the next fire.
 *
 * `SKIP` is what `Bun.cron` does for free: it computes the next fire only after
 * the handler's returned promise settles. There is no `queue` mode - an overrun
 * that must not be dropped is a job, which is `@JobHandler` and bullmq.
 */
export const Overlap = Object.freeze({
  SKIP: 'skip',
  CONCURRENT: 'concurrent',
} as const);

export type Overlap = (typeof Overlap)[keyof typeof Overlap];

export interface ScheduleMeta {
  readonly kind: ScheduleKind;
  /** A cron expression for `CRON`, milliseconds for `INTERVAL` and `ONCE`. */
  readonly at: string | number;
  /** Registry key. Defaults to `ClassName.methodName` at discovery. */
  readonly name?: string;
  /** IANA zone id, `CRON` only. Needs a Bun that honours the option. */
  readonly tz?: string;
  readonly overlap?: Overlap;
  /** Arm at boot. Default `true`. */
  readonly enabled?: boolean;
}

interface ScheduleMarked {
  readonly [SCHEDULE]?: ScheduleMeta;
}

export const markSchedule = (target: object, meta: ScheduleMeta): void => {
  Object.defineProperty(target, SCHEDULE, { value: meta, configurable: true });
};

export const scheduleMetaOf = (value: unknown): ScheduleMeta | undefined =>
  typeof value === 'function' ? (value as ScheduleMarked)[SCHEDULE] : undefined;
