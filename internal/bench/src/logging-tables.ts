/**
 * Renders the `## Request logging cost` section of `README.md` from
 * `results/logging.json`. Called by `src/readme-tables.ts`; returns `null` when no
 * logging run has been recorded, so a checkout without one still builds.
 */
import { resultsDir } from './paths.js';
import type { LoggingReport, LoggingUnit } from './types.js';

const int = (value: number): string =>
  Math.round(value).toLocaleString('en-US');

const micros = (rps: number): number => 1_000_000 / rps;

const signed = (value: number): string =>
  `${value >= 0 ? '+' : '−'}${Math.abs(value).toFixed(2)} µs`;

/** The rows that decompose the shipped path, in order. The rest are asides. */
const LADDER = [
  'off',
  'passthru',
  'path',
  'headers',
  'requestid',
  'als',
  'respheader',
  'entry',
  'timestamp',
  'serialize',
  'default',
] as const;

const find = (report: LoggingReport, id: string): LoggingUnit | undefined =>
  report.units.find((unit) => unit.id === id);

const ladderTable = (report: LoggingReport): string => {
  const rows: string[] = [];
  let previous: number | undefined;
  let baseline: number | undefined;

  for (const id of LADDER) {
    const unit = find(report, id);
    if (unit === undefined) continue;
    const cost = micros(unit.rps.median);
    baseline ??= cost;
    rows.push(
      `| ${unit.label} | ${int(unit.rps.median)} | ${cost.toFixed(2)} | ` +
        `${previous === undefined ? '-' : signed(cost - previous)} | ` +
        `${previous === undefined ? '-' : signed(cost - baseline)} |`,
    );
    previous = cost;
  }

  return [
    '| Step | req/s | µs/req | this step adds | total |',
    '| ---- | ----: | -----: | -------------: | ----: |',
    ...rows,
  ].join('\n');
};

const asideTable = (report: LoggingReport): string => {
  const rows: readonly [string, string][] = [
    ['default', 'batched, `/dev/null`'],
    ['unbatched', 'one `console.log` per entry, `/dev/null`'],
    ['default-blocked', 'batched, into a pipe nobody reads'],
    ['unbatched-blocked', 'one per entry, into a pipe nobody reads'],
  ];

  const body = rows
    .map(([id, label]) => {
      const unit = find(report, id);
      if (unit === undefined) return '';
      return `| ${label} | ${int(unit.rps.median)} | ${micros(unit.rps.median).toFixed(2)} |`;
    })
    .filter((line) => line !== '');

  return [
    '| Write | req/s | µs/req |',
    '| ----- | ----: | -----: |',
    ...body,
  ].join('\n');
};

/**
 * The body options, from their own run. They need a request with a body, so they
 * cannot appear in the `json` ladder above - `bun run logging:bodies` records them
 * against `POST /validate` and writes a second file.
 */
const BODY_LADDER = [
  ['off', null],
  ['default', 'the shipped default, both body options off'],
  ['body-request', null],
  ['body-response', null],
  ['body-both', null],
  ['body-request-unvalidated', null],
] as const;

const bodySection = async (): Promise<string> => {
  const file = Bun.file(`${resultsDir}/logging-bodies.json`);
  if (!(await file.exists())) return '';
  const report = (await file.json()) as LoggingReport;

  const base = find(report, 'default');
  if (base === undefined) return '';
  const against = micros(base.rps.median);

  const rows = BODY_LADDER.map(([id, override]) => {
    const unit = find(report, id);
    if (unit === undefined) return '';
    const cost = micros(unit.rps.median);
    return (
      `| ${override ?? unit.label} | ${int(unit.rps.median)} | ` +
      `${cost.toFixed(2)} | ${id === 'default' ? '-' : signed(cost - against)} |`
    );
  }).filter((line) => line !== '');

  return `
### What logging a body costs

Generated from \`results/logging-bodies.json\`; reproduce with
\`bun run logging:bodies\`. Same round-robin, but on the \`${report.scenario}\`
scenario - a \`POST\` with a body. The ladder above is a \`GET\`, so the body options
are unreachable from it, which is why their cost lived in a doc comment rather than in
this harness for as long as it did.

| Setting | req/s | µs/req | vs the default |
| ------- | ----: | -----: | -------------: |
${rows.join('\n')}

**The two request-body rows differ by one \`Request.clone()\` and nothing else.** A
route that declares a \`body\` schema has its body buffered by the input reader, and
the logger reads that text; a route that declares none leaves the logger to clone the
request, and cloning one whose body is an unread network stream is what the cost has
always been. Not the second parse, which measures at 0.32 µs.

So \`requestBody: true\` is cheap on a validated route and expensive on an
unvalidated one, and that is the number to quote rather than a single figure.
\`responseBody\` needs no equivalent: a response is already a materialised string by
the time anything clones it.
`;
};

export const loggingSection = async (): Promise<string | null> => {
  const file = Bun.file(`${resultsDir}/logging.json`);
  if (!(await file.exists())) return null;
  const report = (await file.json()) as LoggingReport;
  const { machine: m, config: c, loadGenerator: g } = report;

  return `## Request logging cost

Generated from \`results/logging.json\` by \`bun src/readme-tables.ts\` - never
transcribed by hand. Reproduce with \`bun run logging\`.

\`dunx-logging\` in the main suite is one number, and one number cannot say *which*
part of writing a structured line per request is expensive. Every row below is the
same app on the same \`${report.scenario}\` route, in its own process, with one more
piece of the default logging path switched on than the row above it.

\`\`\`
${m.cpuModel}, ${m.cores} logical cores | bun ${m.bun} | ${g.id} ${g.version}
${c.connections} connections | ${c.warmupSeconds}s warmup | ${c.runs} x ${c.durationSeconds}s measured | ${report.generatedAt.slice(0, 10)}
\`\`\`

**Measured round-robin across all rows**, for the reason the validation harness
records: the differences are a few percent and the machine drifts by more than that
over a run. Read anything under about **±0.5 µs** as unresolvable.

${ladderTable(report)}

Reading it: the middleware chain, \`crypto.randomUUID()\` and setting
\`x-request-id\` on the response are each at or below what this harness can resolve.
What costs is the **first touch of \`req.headers\`**, the \`AsyncLocalStorage\`
scope, and **building and serialising the entry** - and, before it was batched, the
write.

### The write, and the pipe nobody was reading

${asideTable(report)}

The last row is what this harness was reporting before either fix, and neither of
its two costs is a property of \`@dunx/http\`. Subjects were spawned with
\`stdout: 'pipe'\` and nothing ever read it: 64 KiB in, the pipe is full and the
server parks on every further write. Subjects now write to \`/dev/null\`, and
\`ConsoleLogger\` batches everything at \`info\` and below into one write per
event-loop turn - which also makes a slow consumer far less able to stall the
server. \`warn\` and above are never batched.
${await bodySection()}`;
};
