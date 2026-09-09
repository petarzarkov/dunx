import { foldFootprint } from './footprint.js';
import { dec, int } from './format.js';
import { invalidates } from './quality.js';
import type { Report, ScenarioResult } from './types.js';

const BASELINE = 'bun-serve';

interface Column {
  readonly header: string;
  readonly align: 'left' | 'right';
}

const render = (
  columns: readonly Column[],
  rows: readonly (readonly string[])[],
): string => {
  const widths = columns.map((column, index) =>
    Math.max(
      column.header.length,
      ...rows.map((row) => (row[index] ?? '').length),
    ),
  );
  const line = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => {
        const width = widths[index] ?? 0;
        return columns[index]?.align === 'right'
          ? cell.padStart(width)
          : cell.padEnd(width);
      })
      .join('  ')
      .trimEnd();
  const divider = widths.map((width) => '-'.repeat(width)).join('  ');
  return [
    line(columns.map((column) => column.header)),
    divider,
    ...rows.map(line),
  ].join('\n');
};

/**
 * One row per subject, across every scenario it was measured on. The fold is
 * `src/footprint.ts`, shared with the README tables and the documentation site,
 * because three copies of it had already begun to disagree.
 *
 * `boot MiB` is the only reading taken with nothing in flight, so it is the one
 * to quote as a footprint; `peak MiB` is what it grew to under load. `procs`
 * makes a forking subject visible - `gunicorn` is a master and a worker, and both
 * are charged to Django.
 */
const formatFootprint = (
  report: Report,
  labels: ReadonlyMap<string, string>,
): string => {
  const rows = foldFootprint(report.resources);

  return [
    '\nRESOURCE FOOTPRINT - resident set of the whole process tree, from /proc',
    '  boot is measured after the first served request and before any load; peak is the highest sample under it',
    render(
      [
        { header: 'subject', align: 'left' },
        { header: 'boot MiB', align: 'right' },
        { header: 'peak MiB', align: 'right' },
        { header: 'procs', align: 'right' },
      ],
      rows.map((row) => [
        labels.get(row.subject) ?? row.subject,
        row.bootMiB === null ? '-' : dec(row.bootMiB, 1),
        dec(row.peakMiB, 1),
        String(row.processes),
      ]),
    )
      .split('\n')
      .map((row) => `  ${row}`)
      .join('\n'),
  ].join('\n');
};

export const formatReport = (report: Report): string => {
  const labels = new Map(
    report.subjects.map((subject) => [subject.id, subject.label]),
  );
  const out: string[] = [];

  out.push('MACHINE');
  out.push(
    `  ${report.machine.cpuModel}, ${report.machine.cores} logical cores, ${report.machine.ramGiB} GiB RAM`,
  );
  out.push(
    `  ${report.machine.platform} ${report.machine.kernel} ${report.machine.arch} | bun ${report.machine.bun} | node ${report.machine.node}`,
  );
  out.push(
    `  load generator: ${report.loadGenerator.id} ${report.loadGenerator.version}` +
      `${report.loadGenerator.binary === null ? '' : ` (${report.loadGenerator.binary})`}`,
  );
  out.push(
    `  ${report.config.connections} connections | ${report.config.warmupSeconds}s warmup | ` +
      `${report.config.runs} x ${report.config.durationSeconds}s measured | ${report.generatedAt}`,
  );
  const longer = report.subjects.filter(
    (subject) =>
      (subject.warmupFloorSeconds ?? 0) > report.config.warmupSeconds,
  );
  if (longer.length > 0) {
    out.push(
      `  longer warmup: ${longer.map((subject) => `${subject.label} ${subject.warmupFloorSeconds}s`).join(', ')}`,
    );
  }

  if (report.toolchains.length > 0) {
    out.push(
      '\nTOOLCHAINS - compiled before the run, so no build time is in the startup column',
    );
    out.push(
      render(
        [
          { header: 'runtime', align: 'left' },
          { header: 'version', align: 'left' },
          { header: 'subjects', align: 'left' },
          { header: 'build s', align: 'right' },
        ],
        report.toolchains.map((chain) => [
          chain.label,
          chain.version ?? 'not found, subjects skipped',
          chain.subjects.join(', ') || '-',
          chain.version === null ? '-' : chain.buildSeconds.toFixed(1),
        ]),
      )
        .split('\n')
        .map((row) => `  ${row}`)
        .join('\n'),
    );
  }

  const ranIo = report.scenarios.some((scenario) => scenario.id === 'io');
  out.push('\nSUBJECTS');
  out.push(
    render(
      [
        { header: 'subject', align: 'left' },
        { header: 'runtime', align: 'left' },
        { header: 'version', align: 'left' },
        { header: 'validator', align: 'left' },
        ...(ranIo ? ([{ header: 'io clients', align: 'left' }] as const) : []),
      ],
      report.subjects.map((subject) => [
        subject.label,
        subject.runtime,
        subject.version,
        subject.validator,
        ...(ranIo ? [subject.io] : []),
      ]),
    )
      .split('\n')
      .map((row) => `  ${row}`)
      .join('\n'),
  );

  for (const scenario of report.scenarios) {
    // A row that failed too often to compare is sorted last and never ranked.
    // Connection failures come back faster than responses do: two Node subjects
    // that died mid-run were recorded at 560,964 req/s of pure errors and sorted
    // to the top of this table above raw `Bun.serve`. "Too often" is a rate, not
    // a count - see `src/quality.ts`.
    const failed = (result: ScenarioResult): number =>
      result.totalErrors + result.totalNon2xx;
    const requestsIn = (result: ScenarioResult): number =>
      result.runs.reduce((total, run) => total + run.requests, 0);
    const unranked = (result: ScenarioResult): boolean =>
      invalidates(failed(result), requestsIn(result));
    const rows = report.results
      .filter((result) => result.scenario === scenario.id)
      .sort(
        (a, b) =>
          Number(unranked(a)) - Number(unranked(b)) ||
          b.rps.median - a.rps.median,
      );
    if (rows.length === 0) continue;
    // A baseline that itself answered errors is not a denominator: every healthy
    // row would then be reported as a percentage of a failure rate, while the
    // baseline row shows `-` for the same reason.
    const baselineRow = rows.find((row) => row.subject === BASELINE);
    const baseline =
      baselineRow === undefined || unranked(baselineRow)
        ? undefined
        : baselineRow.rps.median;

    out.push(
      `\n${scenario.title.toUpperCase()} - ${scenario.method} ${scenario.path}`,
    );
    out.push(`  ${scenario.description}`);
    const broken = rows.filter(unranked);
    if (broken.length > 0) {
      out.push(
        `  ${broken.length} subject(s) answered errors or non-2xx and are listed last with no ratio: ` +
          broken
            .map((row) => labels.get(row.subject) ?? row.subject)
            .join(', '),
      );
    }
    const costs = new Map(
      report.resources
        .filter((usage) => usage.scenario === scenario.id)
        .map((usage) => [usage.subject, usage]),
    );
    const measured = costs.size > 0;

    out.push(
      render(
        [
          { header: 'subject', align: 'left' },
          { header: 'req/s (median)', align: 'right' },
          { header: 'stddev', align: 'right' },
          { header: 'p50 ms', align: 'right' },
          { header: 'p99 ms', align: 'right' },
          { header: `vs ${BASELINE}`, align: 'right' },
          ...(measured
            ? ([
                { header: 'rss MiB', align: 'right' },
                { header: 'cpu ms/kreq', align: 'right' },
              ] as const)
            : []),
          { header: 'bad', align: 'right' },
        ],
        rows.map((row) => {
          const cost = costs.get(row.subject);
          return [
            labels.get(row.subject) ?? row.subject,
            int(row.rps.median),
            int(row.rps.stddev),
            row.latencyP50Ms.median.toFixed(3),
            row.latencyP99Ms.median.toFixed(3),
            baseline === undefined || baseline === 0 || unranked(row)
              ? '-'
              : `${((row.rps.median / baseline) * 100).toFixed(1)}%`,
            ...(measured
              ? [
                  cost === undefined ? '-' : dec(cost.rssPeakMiB.median, 1),
                  cost === undefined || cost.cpuMsPerKiloRequests === null
                    ? '-'
                    : dec(cost.cpuMsPerKiloRequests.median, 2),
                ]
              : []),
            String(row.totalErrors + row.totalNon2xx),
          ];
        }),
      )
        .split('\n')
        .map((row) => `  ${row}`)
        .join('\n'),
    );
  }

  if (report.resources.length > 0) {
    out.push(formatFootprint(report, labels));
  }

  if (report.startup.length > 0) {
    const rows = [...report.startup].sort((a, b) => a.medianMs - b.medianMs);
    out.push('\nSTARTUP - cold process to first served request');
    out.push(
      `  ${report.startup[0]?.samplesMs.length ?? 0} samples each, polled at 1 ms so treat anything under ~5 ms as equal`,
    );
    if (report.toolchains.some((chain) => chain.version !== null)) {
      out.push(
        '  Go, Rust, JVM and .NET artifacts are built before the run: this times the artifact, never the build',
      );
    }
    out.push(
      render(
        [
          { header: 'subject', align: 'left' },
          { header: 'median ms', align: 'right' },
          { header: 'min ms', align: 'right' },
          { header: 'max ms', align: 'right' },
        ],
        rows.map((row) => [
          labels.get(row.subject) ?? row.subject,
          row.medianMs.toFixed(1),
          Math.min(...row.samplesMs).toFixed(1),
          Math.max(...row.samplesMs).toFixed(1),
        ]),
      )
        .split('\n')
        .map((row) => `  ${row}`)
        .join('\n'),
    );
  }

  out.push('\nLOAD GENERATOR LIMITATIONS');
  for (const limitation of report.loadGenerator.limitations)
    out.push(`  - ${limitation}`);

  return `${out.join('\n')}\n`;
};
