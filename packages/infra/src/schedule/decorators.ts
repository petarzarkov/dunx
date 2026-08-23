import { ScheduleError, ScheduleErrorCode } from './errors.js';
import { assertZoneUsable } from './options.js';
import {
  markSchedule,
  ScheduleKind,
  type Overlap,
  type ScheduleMeta,
} from './marker.js';

// never[] is what makes an arbitrary method signature assignable, so a handler may
// declare whatever parameters it wants rather than the widest ones.
type HandlerMethod = (...args: never[]) => unknown;

/**
 * The largest delay `setTimeout` can hold. Bun clamps anything above it to 1 ms and
 * fires at about 17 ms, so a 25-day interval would become a hot loop. Refused at
 * decoration time rather than discovered in production.
 */
const MAX_DELAY = 2_147_483_647;

export interface CronDecoratorOptions {
  /** Registry key. Defaults to `ClassName.methodName`. */
  readonly name?: string;
  /** IANA zone id. Needs a Bun that honours `Bun.cron`'s `tz` option. */
  readonly tz?: string;
  readonly overlap?: Overlap;
  /** Arm at boot. Default `true`. */
  readonly enabled?: boolean;
}

export type TimerDecoratorOptions = Omit<CronDecoratorOptions, 'tz'>;

const assertDelay = (ms: number, decorator: string): number => {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new ScheduleError(
      ScheduleErrorCode.INVALID_SCHEDULE,
      `${decorator}(${String(ms)}): a delay must be a non-negative finite number.`,
    );
  }
  if (ms > MAX_DELAY) {
    throw new ScheduleError(
      ScheduleErrorCode.INTERVAL_TOO_LONG,
      `${decorator}(${ms}): above ${MAX_DELAY} ms Bun clamps the timer to 1 ms and ` +
        'fires it at about 17 ms, so this would be a hot loop rather than a long ' +
        'wait. Use @Cron for anything past 24 days.',
    );
  }
  return ms;
};

const mark =
  (meta: ScheduleMeta) =>
  <T extends HandlerMethod>(value: T): T => {
    markSchedule(value, meta);
    return value;
  };

/**
 * Runs the method on a cron expression, through `Bun.cron`. Five fields, minute
 * resolution: a sixth is rejected, so sub-minute work is `@Interval`.
 *
 * The parameter is `Bun.CronWithAutocomplete`, so `@Cron('@daily')` is offered by
 * an editor. {@link CronExpression} holds the same seven as values.
 *
 * No class decorator: the method's marker is the whole record, found by walking
 * prototype chains, so an abstract base's marked methods are inherited.
 *
 * Validated at decoration time, so an unparseable schedule is a boot error.
 */
export const Cron = (
  expression: Bun.CronWithAutocomplete,
  options: CronDecoratorOptions = {},
) => {
  try {
    Bun.cron.parse(expression, new Date(0));
  } catch (error) {
    throw new ScheduleError(
      ScheduleErrorCode.INVALID_SCHEDULE,
      `@Cron("${expression}"): ${(error as Error).message}`,
      error,
    );
  }
  if (options.tz !== undefined) {
    assertZoneUsable(options.tz, `@Cron("${expression}", { tz })`);
  }

  return mark({ kind: ScheduleKind.CRON, at: expression, ...options });
};

/** Runs the method every `ms`, starting `ms` after the app is ready. */
export const Interval = (ms: number, options: TimerDecoratorOptions = {}) =>
  mark({
    kind: ScheduleKind.INTERVAL,
    at: assertDelay(ms, '@Interval'),
    ...options,
  });

/**
 * Runs the method once, `ms` after the app is ready. "Ready" is `onInit`, which
 * runs before `Bun.serve` binds, so the delay is measured from container
 * readiness and `@OnceOnBoot(0)` fires before the socket is open. An app needing
 * the later point uses `forRoot({ enabled: false })` and `registry.add`.
 */
export const OnceOnBoot = (ms: number, options: TimerDecoratorOptions = {}) =>
  mark({
    kind: ScheduleKind.ONCE,
    at: assertDelay(ms, '@OnceOnBoot'),
    ...options,
  });
