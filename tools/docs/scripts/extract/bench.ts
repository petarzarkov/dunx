import { existsSync, readFileSync } from 'node:fs';
import {
  BENCH_SCHEMA_VERSION,
  type BenchModel,
  type BenchReport,
} from './model';

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
  results: report.results.map((result) => ({
    subject: result.subject,
    scenario: result.scenario,
    rps: result.rps.median,
    rpsStddev: result.rps.stddev,
    p50Ms: result.latencyP50Ms.median,
    p99Ms: result.latencyP99Ms.median,
    bad: result.totalErrors + result.totalNon2xx,
  })),
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
    console.warn('docs: no benchmark run at tools/bench/results/latest.json');
    return null;
  }

  const report = JSON.parse(readFileSync(file, 'utf8')) as BenchReport;
  if (report.schemaVersion !== BENCH_SCHEMA_VERSION) {
    console.warn(
      `docs: benchmark schemaVersion ${report.schemaVersion}, expected ${BENCH_SCHEMA_VERSION} — skipping`,
    );
    return null;
  }

  return projectBench(report);
};
