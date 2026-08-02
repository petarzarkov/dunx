import type { Report } from './types.js';

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

const int = (value: number): string =>
  Math.round(value).toLocaleString('en-US');

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

  out.push('\nSUBJECTS');
  out.push(
    render(
      [
        { header: 'subject', align: 'left' },
        { header: 'runtime', align: 'left' },
        { header: 'version', align: 'left' },
        { header: 'validator', align: 'left' },
      ],
      report.subjects.map((subject) => [
        subject.label,
        subject.runtime,
        subject.version,
        subject.validator,
      ]),
    )
      .split('\n')
      .map((row) => `  ${row}`)
      .join('\n'),
  );

  for (const scenario of report.scenarios) {
    const rows = report.results
      .filter((result) => result.scenario === scenario.id)
      .sort((a, b) => b.rps.median - a.rps.median);
    if (rows.length === 0) continue;
    const baseline = rows.find((row) => row.subject === BASELINE)?.rps.median;

    out.push(
      `\n${scenario.title.toUpperCase()} - ${scenario.method} ${scenario.path}`,
    );
    out.push(`  ${scenario.description}`);
    out.push(
      render(
        [
          { header: 'subject', align: 'left' },
          { header: 'req/s (median)', align: 'right' },
          { header: 'stddev', align: 'right' },
          { header: 'p50 ms', align: 'right' },
          { header: 'p99 ms', align: 'right' },
          { header: `vs ${BASELINE}`, align: 'right' },
          { header: 'bad', align: 'right' },
        ],
        rows.map((row) => [
          labels.get(row.subject) ?? row.subject,
          int(row.rps.median),
          int(row.rps.stddev),
          row.latencyP50Ms.median.toFixed(3),
          row.latencyP99Ms.median.toFixed(3),
          baseline === undefined || baseline === 0
            ? '-'
            : `${((row.rps.median / baseline) * 100).toFixed(1)}%`,
          String(row.totalErrors + row.totalNon2xx),
        ]),
      )
        .split('\n')
        .map((row) => `  ${row}`)
        .join('\n'),
    );
  }

  if (report.startup.length > 0) {
    const rows = [...report.startup].sort((a, b) => a.medianMs - b.medianMs);
    out.push('\nSTARTUP - cold process to first served request');
    out.push(
      `  ${report.startup[0]?.samplesMs.length ?? 0} samples each, polled at 1 ms so treat anything under ~5 ms as equal`,
    );
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
