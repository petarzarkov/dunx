import { AppError } from '@dunx/core';

/** Frozen object rather than an `enum` - see CLAUDE.md. */
export const ScheduleErrorCode = Object.freeze({
  /** Two schedules claim the same registry name. A boot error. */
  DUPLICATE_SCHEDULE: 'ERR_SCHEDULE_DUPLICATE',
  /** A cron expression `Bun.cron` will not parse, or a zone id nothing knows. */
  INVALID_SCHEDULE: 'ERR_SCHEDULE_INVALID',
  /** An interval or timeout Bun's timers cannot express. */
  INTERVAL_TOO_LONG: 'ERR_SCHEDULE_INTERVAL_TOO_LONG',
  /** A named zone on a runtime that silently ignores the option. */
  TZ_UNSUPPORTED: 'ERR_SCHEDULE_TZ_UNSUPPORTED',
  /** `trigger` or `remove` named a schedule the registry does not hold. */
  UNKNOWN_SCHEDULE: 'ERR_SCHEDULE_UNKNOWN',
} as const);

export type ScheduleErrorCode =
  (typeof ScheduleErrorCode)[keyof typeof ScheduleErrorCode];

export class ScheduleError extends AppError {
  override name = 'ScheduleError';

  constructor(
    readonly code: ScheduleErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
  }
}
