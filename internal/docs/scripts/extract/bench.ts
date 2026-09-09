import { existsSync, readFileSync } from 'node:fs';
import { median } from '../../../bench/src/stats.js';
import {
  BENCH_SCHEMA_VERSION,
  type BenchFootprint,
  type BenchModel,
  type BenchReport,
} from './model';

/**
 * One row per subject out of the harness's per-scenario resource rows.
 *
 * `bootMiB` is a median rather than a sum: it is the same measurement taken once
 * per scenario, of a process doing nothing, so the scenarios are repeats of one
 * reading. `peakMiB` is the highest anything reached under any load, which is the
 * figure a reader sizing a container wants.
 *
 * The median comes from the harness, which `model.ts` already reaches into for
 * every type in this file. A local one written as `sorted[length >> 1]` takes the
 * upper of the two middle readings on an even sample count, which is not a median
 * and skews the published figure high every time the scenario count is even.
 */
const foldFootprint = (report: BenchReport): BenchFootprint[] => {
  const bySubject = new Map<string, typeof report.resources>();
  for (const usage of report.resources) {
    bySubject.set(usage.subject, [
      ...(bySubject.get(usage.subject) ?? []),
      usage,
    ]);
  }

  return [...bySubject].flatMap(([subject, list]) => {
    const boots = list
      .map((one) => one.rssBootMiB)
      .filter((one): one is number => one !== null);
    if (boots.length === 0) return [];
    return [
      {
        subject,
        bootMiB: median(boots),
        peakMiB: Math.max(...list.map((one) => one.rssPeakMiB.max)),
        processes: Math.max(...list.map((one) => one.processes)),
      },
    ];
  });
};

/**
 * Narrows the harness's report to the fields the site renders. See the
 * `BenchModel` doc comment for why.
 */
export const projectBench = (report: BenchReport): BenchModel => ({
  schemaVersion: report.schemaVersion,
  generatedAt: report.generatedAt,
  machine: report.machine,
  loadGenerator: report.loadGenerator,
  config: report.config,
  subjects: report.subjects.map((subject) => ({
    id: subject.id,
    label: subject.label,
    runtime: subject.runtime,
    version: subject.version,
    validator: subject.validator,
    notes: subject.notes,
  })),
  scenarios: report.scenarios.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    description: scenario.description,
    method: scenario.method,
    path: scenario.path,
  })),
  results: report.results.map((result) => {
    const usage = report.resources.find(
      (one) =>
        one.subject === result.subject && one.scenario === result.scenario,
    );
    return {
      subject: result.subject,
      scenario: result.scenario,
      rps: result.rps.median,
      rpsStddev: result.rps.stddev,
      p50Ms: result.latencyP50Ms.median,
      p99Ms: result.latencyP99Ms.median,
      bad: result.totalErrors + result.totalNon2xx,
      peakMiB: usage?.rssPeakMiB.median ?? null,
      cpuMsPerKiloRequests: usage?.cpuMsPerKiloRequests.median ?? null,
    };
  }),
  footprint: foldFootprint(report),
  startup: report.startup.map((entry) => ({
    subject: entry.subject,
    medianMs: entry.medianMs,
    minMs: Math.min(...entry.samplesMs),
    maxMs: Math.max(...entry.samplesMs),
  })),
});

/**
 * `results/` is gitignored bar the one published run, and a benchmark takes
 * minutes to produce, so a clean checkout can legitimately have no report. That
 * is not a build failure: the page says so and the rest of the site is
 * unaffected. A report from a future schema is treated the same way rather than
 * rendered through a mismatched reader.
 */
export const readBench = (file: string): BenchModel | null => {
  if (!existsSync(file)) {
    console.warn(
      'docs: no benchmark run at internal/bench/results/latest.json',
    );
    return null;
  }

  // Read the version off untyped JSON, not off `BenchReport`. The harness types
  // `schemaVersion` as the literal `1`, so checking it through that type narrows the
  // mismatch branch to `never` and the guard stops guarding - while the file on disk
  // is whatever a previous version of the harness wrote.
  const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
  // `null` is valid JSON and reading a property off it throws, which would turn a
  // truncated report into a crashed build rather than a skipped section.
  const version =
    typeof raw === 'object' && raw !== null
      ? (raw as { schemaVersion?: unknown }).schemaVersion
      : undefined;
  if (version !== BENCH_SCHEMA_VERSION) {
    console.warn(
      `docs: benchmark schemaVersion ${String(version)}, expected ${BENCH_SCHEMA_VERSION} - skipping`,
    );
    return null;
  }
  const report = raw as BenchReport;

  return projectBench(report);
};
