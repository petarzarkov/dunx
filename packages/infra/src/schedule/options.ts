import { getZone, type TimezoneCode } from '@arkv/timezones';
import { supportsTz } from './capability.js';
import { ScheduleError, ScheduleErrorCode } from './errors.js';
import { Overlap } from './marker.js';

/**
 * A zone id `@arkv/timezones` knows, or a boot error.
 *
 * The cast is the one wart. `getZone` is typed against the generated union of every
 * zone id, so an arbitrary string cannot be passed without it; the runtime answer
 * is exactly the check wanted, `null` for anything the tzdb does not hold. An
 * `isTimezoneCode` type guard upstream would remove the cast, and is the only thing
 * this needs from `@arkv/timezones` that it does not already do.
 */
const assertZone = (zone: string, where: string): string => {
  if (getZone(zone as TimezoneCode) === null) {
    throw new ScheduleError(
      ScheduleErrorCode.INVALID_SCHEDULE,
      `${where}: "${zone}" is not an IANA zone id. A typo here would be a schedule ` +
        'that never fires at the hour it names, so it is a boot error.',
    );
  }
  return zone;
};

/**
 * A named zone on a runtime that ignores the option would run at the wrong hour
 * silently, so asking for one is refused rather than honoured approximately. `UTC`
 * is always allowed: it is what an ignoring runtime already does.
 */
export const assertZoneUsable = (zone: string, where: string): string => {
  assertZone(zone, where);
  if (zone !== 'UTC' && !supportsTz()) {
    throw new ScheduleError(
      ScheduleErrorCode.TZ_UNSUPPORTED,
      `${where}: this Bun (${Bun.version}) ignores Bun.cron's tz option, so ` +
        `"${zone}" would run at the UTC hour instead with no error. Either drop the ` +
        'zone and write the expression in UTC, or run a Bun that honours it.',
    );
  }
  return zone;
};

export interface ScheduleOptionsInit {
  /** Arm discovered schedules at boot. Default `true`. */
  readonly enabled?: boolean;
  /** Default zone for a `@Cron` that names none. Default `'UTC'`. */
  readonly tz?: string;
  /**
   * Hold the event loop open while schedules are armed. Default `true`, matching
   * `Bun.cron`. `false` unrefs every handle, so a process with nothing else to do
   * exits instead of waiting for the next fire.
   */
  readonly keepAlive?: boolean;
  /** Default overlap policy. Default `Overlap.SKIP`. */
  readonly overlap?: Overlap;
}

/**
 * A class rather than an interface, so the container has a runtime value to record
 * at an injection site. An interface there is a boot error.
 *
 * `tz` defaults to `'UTC'` and is passed to `Bun.cron` explicitly rather than left
 * unset. That is correct on both sides of Bun's 1.4 change: 1.3.x ignores the
 * option and is already UTC, and 1.4 honours it and pins UTC rather than drifting
 * to whatever `TZ` the container has.
 */
export class ScheduleOptions {
  readonly enabled: boolean;
  readonly tz: string;
  readonly keepAlive: boolean;
  readonly overlap: Overlap;

  constructor(init: ScheduleOptionsInit = {}) {
    this.enabled = init.enabled ?? true;
    this.tz = assertZoneUsable(
      init.tz ?? 'UTC',
      'ScheduleModule.forRoot({ tz })',
    );
    this.keepAlive = init.keepAlive ?? true;
    this.overlap = init.overlap ?? Overlap.SKIP;
  }
}
