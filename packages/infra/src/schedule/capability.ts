/**
 * Whether this Bun honours `Bun.cron`'s `tz` option. On 1.3.14 it is silently
 * ignored and an unknown zone does not throw, so a zoned `@Cron` would run at UTC
 * with no error. Bun 1.4 honours it and flips the default to the local zone
 * (oven-sh/bun#36461); `ScheduleRegistry` passes `tz` on every call.
 *
 * Probed rather than read off `Bun.version`: a version string says which build
 * this is, not what it does.
 *
 * The probe asks for one wall-clock time in UTC and in Kolkata, UTC+05:30, an
 * offset no rounding can hide.
 */

const ZONE = 'Asia/Kolkata';
const FROM = new Date('2026-01-15T00:00:00Z');
const EXPRESSION = '0 12 * * *';

let cached: boolean | undefined;

export const supportsTz = (): boolean => {
  if (cached !== undefined) return cached;

  try {
    const utc = Bun.cron.parse(EXPRESSION, FROM, { tz: 'UTC' });
    const zoned = Bun.cron.parse(EXPRESSION, FROM, { tz: ZONE });
    cached =
      utc !== null && zoned !== null && utc.getTime() !== zoned.getTime();
  } catch {
    // A build that rejects the option outright does not honour it either.
    cached = false;
  }

  return cached;
};
