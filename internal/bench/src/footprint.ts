/**
 * One resident-set row per subject, folded from the per-scenario readings.
 *
 * Three near-identical copies of this existed - the stdout table, the README
 * table and the documentation site's extractor - and the third already disagreed
 * with the other two about a subject with no boot reading. A change to how a
 * missing reading renders would have landed in one of them.
 */
import { median } from './stats.js';
import type { ResourceUsage } from './types.js';

export interface Footprint {
  readonly subject: string;
  /**
   * The same measurement repeated once per scenario, of a process doing nothing,
   * so a median across them is a median of repeats rather than of five different
   * things. `null` when no scenario produced one.
   */
  readonly bootMiB: number | null;
  readonly peakMiB: number;
  /** Processes in the tree. `gunicorn` is a master and a worker, so Django is 2. */
  readonly processes: number;
}

export const foldFootprint = (
  resources: readonly ResourceUsage[],
): Footprint[] => {
  const bySubject = new Map<string, ResourceUsage[]>();
  for (const usage of resources) {
    bySubject.set(usage.subject, [
      ...(bySubject.get(usage.subject) ?? []),
      usage,
    ]);
  }

  return [...bySubject]
    .map(([subject, list]) => {
      const boots = list
        .map((one) => one.rssBootMiB)
        .filter((one): one is number => one !== null);
      return {
        subject,
        bootMiB: boots.length === 0 ? null : median(boots),
        peakMiB: Math.max(...list.map((one) => one.rssPeakMiB.max)),
        processes: Math.max(...list.map((one) => one.processes)),
      };
    })
    .sort((a, b) => a.peakMiB - b.peakMiB);
};
