import { Controller, Get, SkipThrottle, Throttle } from '@dunx/http';

/**
 * What the limit looks like from the outside.
 *
 * The module's default is generous, so the interesting cases are the two
 * decorators: `@Throttle` replaces it for one handler, `@SkipThrottle` opts out.
 * A limit on the class would cover every handler here, and a handler's own would
 * still win - the same precedence `@Roles` has.
 */
@Controller('limits')
export class LimitsController {
  /**
   * Three per minute, per subject. The fourth is a 429 carrying `retry-after`,
   * thrown rather than returned, so it comes out in the app's own error shape.
   */
  @Throttle({ limit: 3, windowSeconds: 60 })
  @Get('/burst')
  burst(): { allowed: true } {
    return { allowed: true };
  }

  /** Exempt. A probe or an internal callback that must never be counted. */
  @SkipThrottle()
  @Get('/exempt')
  exempt(): { counted: false } {
    return { counted: false };
  }

  /** The module default, which is what every other route in this app gets. */
  @Get('/default')
  standard(): { ok: true } {
    return { ok: true };
  }
}
