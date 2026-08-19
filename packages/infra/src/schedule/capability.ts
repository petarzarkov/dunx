/**
 * Whether this Bun honours `Bun.cron`'s `tz` option.
 *
 * On 1.3.14 the option is **silently ignored**: `Bun.cron.parse` returns the same
 * instant with and without it, and a zone id nothing recognises does not throw. So
 * `@Cron('0 9 * * *', { tz: 'America/New_York' })` would run at 09:00 UTC with no
 * error anywhere. Bun 1.4 honours it, and also flips the default from UTC to the
 * container's local zone (oven-sh/bun#36461).
 *
 * Probed rather than read off `Bun.version`, because a version string says which
 * build this is and not what it does: a backport, a patch release or a fork would
 * make the comparison wrong in whichever direction happened to be unlucky.
 *
 * The probe asks for the same wall-clock time in UTC and in a zone half an hour off
 * it, and reads whether the two answers differ. Kolkata is UTC+05:30, so an offset
 * this cannot round away.
 */
import { parseCron } from './bun-cron.js';

const ZONE = 'Asia/Kolkata';
const FROM = new Date('2026-01-15T00:00:00Z');
const EXPRESSION = '0 12 * * *';

let cached: boolean | undefined;

export const supportsTz = (): boolean => {
  if (cached !== undefined) return cached;

  try {
    const utc = parseCron(EXPRESSION, FROM, { tz: 'UTC' });
    const zoned = parseCron(EXPRESSION, FROM, { tz: ZONE });
    cached =
      utc !== null && zoned !== null && utc.getTime() !== zoned.getTime();
  } catch {
    // A build that rejects the option outright does not honour it either.
    cached = false;
  }

  return cached;
};
