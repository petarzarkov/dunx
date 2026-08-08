/**
 * The formatters every panel shares. Here rather than in `@dunx/ui` because they
 * are about *this* page's data - bytes of heap, the age of a job - and a design
 * system that knew about job ages would be the wrong shape.
 */

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'] as const;

export const bytes = (value: number): string => {
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < UNITS.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${UNITS[unit]}`;
};

/**
 * A duration a human reads at a glance: `340ms`, `12s`, `4m 10s`, `3d 2h`.
 *
 * Two units at most, and never a fractional one - `1.7 hours` takes longer to
 * understand than `1h 42m`, which is the whole job of this function.
 */
export const duration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

/**
 * How long ago, against the **server's** clock rather than the browser's.
 *
 * `RuntimeReport.now` exists for this: a laptop several minutes off UTC would
 * otherwise render every job as enqueued in the future, which reads as a bug in
 * the queue rather than in the clock.
 */
export const ago = (timestamp: number, now: number): string =>
  timestamp <= 0 ? '-' : `${duration(Math.max(0, now - timestamp))} ago`;

/** A count, grouped, so six figures of completed jobs stay readable. */
export const count = (value: number): string => value.toLocaleString('en-US');
