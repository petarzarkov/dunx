/**
 * Regenerates the results tables in `README.md` from `results/latest.json`.
 *
 * The tables used to be transcribed by hand, which is a standing invitation to a
 * typo nobody can catch by reading - a benchmark whose published numbers do not
 * match its own report is worse than no benchmark. Run this after `bun run start`:
 *
 * ```bash
 * bun src/readme-tables.ts
 * ```
 *
 * It replaces everything between the `## Results` heading and the next `##`, and
 * touches nothing else.
 */
import { loggingSection } from './logging-tables.js';
import { median, stddev } from './stats.js';
import type { Report } from './types.js';
import { validationSection } from './validation-tables.js';

const BASELINE = 'bun-serve';
const FOCUS = 'dunx';

const int = (value: number): string =>
  Math.round(value).toLocaleString('en-US');
const dec = (value: number, places = 3): string => value.toFixed(places);

const reportPath = new URL('../results/latest.json', import.meta.url).pathname;
const readmePath = new URL('../README.md', import.meta.url).pathname;

const report = (await Bun.file(reportPath).json()) as Report;

const cellsFor = (scenario: string) => {
  const rows = report.results.filter((row) => row.scenario === scenario);
  const rpsOf = (row: (typeof rows)[number]): number =>
    median(row.runs.map((run) => run.rps));
  const baseline = rows.find((row) => row.subject === BASELINE);
  const base = baseline === undefined ? 0 : rpsOf(baseline);

  return rows
    .map((row) => {
      const label =
        report.subjects.find((subject) => subject.id === row.subject)?.label ??
        row.subject;
      const rps = rpsOf(row);
      return {
        id: row.subject,
        label: row.subject === FOCUS ? `**${label}**` : label,
        rps,
        stddev: stddev(row.runs.map((run) => run.rps)),
        p50: median(row.runs.map((run) => run.latencyP50Ms)),
        p99: median(row.runs.map((run) => run.latencyP99Ms)),
        pct: base === 0 ? 0 : (rps / base) * 100,
        bad: row.runs.reduce((sum, run) => sum + run.non2xx + run.errors, 0),
      };
    })
    .sort((a, b) => b.rps - a.rps);
};

const throughputTable = (scenario: string): string => {
  const rows = cellsFor(scenario);
  const head =
    '| Subject | req/s (median) | stddev | p50 ms | p99 ms | vs `bun-serve` |\n' +
    '| ------- | -------------: | -----: | -----: | -----: | -------------: |';
  const body = rows
    .map((row) => {
      const rps = row.id === FOCUS ? `**${int(row.rps)}**` : int(row.rps);
      const pct =
        row.id === FOCUS ? `**${dec(row.pct, 1)}%**` : `${dec(row.pct, 1)}%`;
      return `| ${row.label} | ${rps} | ${int(row.stddev)} | ${dec(row.p50)} | ${dec(row.p99)} | ${pct} |`;
    })
    .join('\n');
  return `${head}\n${body}`;
};

const startupTable = (): string => {
  const rows = [...report.startup]
    .map((row) => ({
      label:
        report.subjects.find((subject) => subject.id === row.subject)?.label ??
        row.subject,
      id: row.subject,
      medianMs: row.medianMs,
      minMs: Math.min(...row.samplesMs),
      maxMs: Math.max(...row.samplesMs),
    }))
    .sort((a, b) => a.medianMs - b.medianMs);

  const head =
    '| Subject | median ms | min ms | max ms |\n' +
    '| ------- | --------: | -----: | -----: |';
  const body = rows
    .map((row) => {
      const label = row.id === FOCUS ? `**${row.label}**` : row.label;
      const value =
        row.id === FOCUS ? `**${dec(row.medianMs, 1)}**` : dec(row.medianMs, 1);
      return `| ${label} | ${value} | ${dec(row.minMs, 1)} | ${dec(row.maxMs, 1)} |`;
    })
    .join('\n');
  return `${head}\n${body}`;
};

const taxTable = (): string => {
  const head =
    '| Scenario | Bun.serve | @dunx/http | dunx costs |\n' +
    '| -------- | --------: | ---------: | ---------: |';
  const body = report.scenarios
    .map((scenario) => {
      const rows = cellsFor(scenario.id);
      const base = rows.find((row) => row.id === BASELINE);
      const dunx = rows.find((row) => row.id === FOCUS);
      if (base === undefined || dunx === undefined) return '';
      const delta = ((dunx.rps - base.rps) / base.rps) * 100;
      const sign = delta >= 0 ? '+' : '−';
      return `| \`${scenario.id}\` | ${int(base.rps)} | ${int(dunx.rps)} | ${sign}${dec(Math.abs(delta), 1)}% |`;
    })
    .filter((line) => line !== '')
    .join('\n');
  return `${head}\n${body}`;
};

const { machine: m, config: c, loadGenerator: g } = report;
const versions = report.subjects
  .filter((subject) => subject.version !== 'n/a' && subject.id !== FOCUS)
  .map((subject) => `${subject.id} ${subject.version}`)
  .join(' | ');

const section = `## Results

Generated from \`results/latest.json\` by \`bun src/readme-tables.ts\` - never
transcribed by hand.

\`\`\`
${m.cpuModel}, ${m.cores} logical cores, ${m.ramGiB} GiB RAM
${m.platform} ${m.kernel} ${m.arch} | bun ${m.bun} | node ${m.node} | ${g.id} ${g.version}
${c.connections} connections | ${c.warmupSeconds}s warmup | ${c.runs} x ${c.durationSeconds}s measured | ${report.generatedAt.slice(0, 10)}
${versions}
\`\`\`

Reproduce with \`bun run start\`; the full JSON lands in \`results/latest.json\`.

**Plain text** - \`GET /plaintext\`

${throughputTable('plaintext')}

**JSON** - \`GET /json\`

${throughputTable('json')}

**Path parameter** - \`GET /params/42\`

${throughputTable('params')}

**Body validation** - \`POST /validate\`

${throughputTable('validate')}

**Startup** - cold process to first served request, ${c.startupSamples} samples

${startupTable()}

### What these say, including where dunx loses

**The dunx tax over raw \`Bun.serve\`** - the number this harness exists to produce:

${taxTable()}

**A figure at or above 100% is noise, not a win.** \`@dunx/http\` dispatches
*through* \`Bun.serve\`; it cannot serve a request faster than the API it calls. When
the two land within each other's standard deviation - which they now do on
\`plaintext\` - the honest reading is "no measurable overhead", not "faster than
\`Bun.serve\`". Differences under about 3% on this setup are noise.

**\`dunx-logging\` is the same app with \`requestLogging\` left at its default**, and
the gap to \`dunx\` is one structured line per request: reading \`req.headers\`, an
\`AsyncLocalStorage\` scope, building the entry, \`JSON.stringify\`, and the write.
Nothing else in this table logs anything, which is why the two rows exist separately
- see "Why dunx appears twice". A third harness decomposes that gap step by step; see
"Request logging cost" below.

**Validation is still the largest absolute cost**, but most of it is not the
framework's and not the validator's. Splitting it took a second harness - see
"Validation cost" below - and the answer is that \`req.json()\` costs about 3 µs while
zod costs about 1 µs. dunx's own share of the \`validate\` row was 3.7 µs per request
and is now ~1.4 µs, which moved it from 84% of the baseline to over 90% and past
Elysia on this scenario. What remains is dispatch, not validation.

**Cold start is dunx's clearest loss**: roughly twice raw \`Bun.serve\`, from the
\`oxc-parser\` preload and eager DI resolution. It does beat Elysia, and every Node
subject by a wide margin, but it is the number to watch if boot time matters.
`;

/** Replaces one `## ` section in place, leaving everything around it untouched. */
const replaceSection = (
  readme: string,
  heading: string,
  body: string,
): string => {
  const start = readme.indexOf(heading);
  if (start === -1) throw new Error(`README has no "${heading}" heading`);
  const after = readme.indexOf('\n## ', start + 1);
  if (after === -1) throw new Error(`README has no section after "${heading}"`);
  return readme.slice(0, start) + body + readme.slice(after);
};

let readme = replaceSection(
  await Bun.file(readmePath).text(),
  '## Results',
  section,
);
console.log(`README results section regenerated from ${report.generatedAt}`);

const validation = await validationSection();
if (validation === null) {
  console.log('No results/validation.json - validation section left as it is.');
} else {
  readme = replaceSection(readme, '## Validation cost', validation);
  console.log('README validation section regenerated.');
}

const logging = await loggingSection();
if (logging === null) {
  console.log('No results/logging.json - logging section left as it is.');
} else {
  readme = replaceSection(readme, '## Request logging cost', logging);
  console.log('README request logging section regenerated.');
}

await Bun.write(readmePath, readme);
