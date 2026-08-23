import { Controller, Get, SkipThrottle, Throttle } from '@dunx/http';

/**
 * `@Throttle` replaces the module default for one handler, `@SkipThrottle` opts
 * out. A class-level limit covers every handler, and a handler's own still wins.
 */
@Controller('limits')
export class LimitsController {
  /** Three per minute per subject; the fourth is a thrown 429 with
   * `retry-after`, so it takes the app's own error shape. */
  @Throttle({ limit: 3, windowSeconds: 60 })
  @Get('/burst')
  burst(): { allowed: true } {
    return { allowed: true };
  }

  /** Exempt: a probe or internal callback that must never be counted. */
  @SkipThrottle()
  @Get('/exempt')
  exempt(): { counted: false } {
    return { counted: false };
  }

  @Get('/default')
  standard(): { ok: true } {
    return { ok: true };
  }
}
