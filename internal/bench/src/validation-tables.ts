/**
 * Renders the `## Validation cost` section of `README.md` from
 * `results/validation.json`. Called by `src/readme-tables.ts`; returns `null` when
 * no validation run has been recorded, so a checkout without one still builds.
 */
import { resultsDir } from './paths.js';
import type { ValidationReport, ValidationUnit } from './types.js';

const int = (value: number): string =>
  Math.round(value).toLocaleString('en-US');

/** Throughput is the measurement; microseconds per request is what adds up. */
const micros = (rps: number): number => 1_000_000 / rps;

const delta = (from: number, to: number): string => {
  const added = micros(to) - micros(from);
  return `${added >= 0 ? '+' : '−'}${Math.abs(added).toFixed(2)} µs`;
};

const find = (
  report: ValidationReport,
  id: string,
): ValidationUnit | undefined => report.units.find((unit) => unit.id === id);

const rpsOf = (report: ValidationReport, id: string): number =>
  find(report, id)?.rps.median ?? 0;

const stepTable = (report: ValidationReport): string => {
  const steps: readonly [string, string][] = [
    ['raw:json', '`GET /json` - no request body at all'],
    ['raw:discard', '`POST`, body on the wire, never read'],
    ['raw:parse', '`POST` + `await req.json()`'],
    ['raw:zod', '`POST` + `req.json()` + zod'],
  ];

  const rows = steps
    .map(([id, label], index) => {
      const unit = find(report, id);
      if (unit === undefined) return '';
      const previous = steps[index - 1];
      const added =
        previous === undefined
          ? '-'
          : delta(rpsOf(report, previous[0]), unit.rps.median);
      return `| ${label} | ${int(unit.rps.median)} | ${micros(unit.rps.median).toFixed(2)} | ${added} |`;
    })
    .filter((line) => line !== '');

  return [
    '| Step | req/s | µs/req | this step adds |',
    '| ---- | ----: | -----: | -------------: |',
    ...rows,
  ].join('\n');
};

const frameworkTable = (report: ValidationReport): string => {
  const rows: readonly [string, string][] = [
    ['raw:parse', 'raw `Bun.serve`, parse in the handler'],
    ['dunx:manual-parse', '`@dunx/http`, no schemas, parse in the handler'],
    [
      'dunx:manual-validate',
      '`@dunx/http`, no schemas, validate in the handler',
    ],
    ['dunx:zod', '`@dunx/http`, `body` declared - the framework does it'],
  ];

  const body = rows
    .map(([id, label]) => {
      const unit = find(report, id);
      if (unit === undefined) return '';
      return `| ${label} | ${int(unit.rps.median)} | ${micros(unit.rps.median).toFixed(2)} |`;
    })
    .filter((line) => line !== '');

  return [
    '| Subject | req/s | µs/req |',
    '| ------- | ----: | -----: |',
    ...body,
  ].join('\n');
};

/**
 * `noop`/`noop-async` are last whatever they score: they are not validators, and
 * sorting them in among libraries invites reading them as one.
 */
const validatorTable = (report: ValidationReport): string => {
  const parse = rpsOf(report, 'raw:parse');
  const rows = report.units
    .filter((unit) => unit.group === 'validator' && unit.subject === 'dunx')
    .map((unit) => {
      const raw = find(report, `raw:${unit.validator}`);
      if (raw === undefined) return null;
      return {
        validator: unit.validator,
        isNoop: unit.validator.startsWith('noop'),
        raw: raw.rps.median,
        dunx: unit.rps.median,
        // Everything above `raw:parse`, which is the same request with no
        // validation at all. A reading at or below zero means "under the noise
        // floor", not "free" - it is printed rather than clamped.
        cost: micros(raw.rps.median) - micros(parse),
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) =>
      a.isNoop === b.isNoop
        ? a.cost - b.cost
        : Number(a.isNoop) - Number(b.isNoop),
    );

  const body = rows.map(
    (row) =>
      `| ${row.validator} | ${row.cost.toFixed(2)} µs | ${int(row.raw)} | ` +
      `${int(row.dunx)} | ${((row.dunx / row.raw) * 100).toFixed(1)}% |`,
  );

  return [
    '| Validator | costs | raw `Bun.serve` req/s | `@dunx/http` req/s | dunx vs raw |',
    '| --------- | ----: | --------------------: | -----------------: | ----------: |',
    ...body,
  ].join('\n');
};

export const validationSection = async (): Promise<string | null> => {
  const file = Bun.file(`${resultsDir}/validation.json`);
  if (!(await file.exists())) return null;
  const report = (await file.json()) as ValidationReport;
  const { machine: m, config: c, loadGenerator: g } = report;

  return `## Validation cost

Generated from \`results/validation.json\` by \`bun src/readme-tables.ts\` - never
transcribed by hand. Reproduce with \`bun run validation\`.

The main suite above holds the validator constant at zod on purpose, which folds two
costs into one number: what parsing and validating cost *at all*, and what
\`@dunx/http\` adds on top. This section separates them.

\`\`\`
${m.cpuModel}, ${m.cores} logical cores | bun ${m.bun} | ${g.id} ${g.version}
${c.connections} connections | ${c.warmupSeconds}s warmup | ${c.runs} x ${c.durationSeconds}s measured | ${report.generatedAt.slice(0, 10)}
\`\`\`

**Every row is one fresh process, and the measured rounds are interleaved across all
of them** rather than run to completion one row at a time - the differences here are
2-4% and the machine drifts by more than that over a run. Read anything under about
**±0.3 µs** as unresolvable: that is what the run-to-run standard deviations work out
to at this throughput.

### Parsing costs more than validating

Four raw \`Bun.serve\` routes, each doing exactly one thing more than the one above
it, all answering the same bytes:

${stepTable(report)}

**\`req.json()\` is the expensive step by a wide margin**, and putting the body on the
wire is near-free - the difference between *sending* it and *reading* it is what
costs. No framework can remove that, and no choice of validator affects it. The
primitive that would is a validating parser Bun does not ship; see
[\`docs/bun-apis.md\`](../../docs/bun-apis.md).

### Validators through the same Standard Schema seam

The same dunx app and the same schema shape, with only the library behind
\`~standard\` changed. **costs** is that validator's own time - the raw \`Bun.serve\`
row's µs/req above the \`req.json()\`-only row.

${validatorTable(report)}

**zod, Valibot and ArkType are within noise of each other**, and the two compiled
options are at or below what this harness can resolve at this payload size. Every one
of them is cheaper than \`req.json()\`, so **there is no throughput argument for
choosing between them** - pick on API, error quality and ecosystem. If a profile
genuinely points at validation, the compiled route is there.

\`noop\` and \`noop-async\` are the last two rows and are not validators: \`noop\` is a
hand-written pass-through, which is dunx's plumbing with the validator's cost taken
out, and \`noop-async\` is the same thing behind a resolved promise - so the gap
between them is what a validator that answers asynchronously costs.

Neither TypeBox 0.34 nor ajv 8 ships \`~standard\`. Both were bridged in about ten
lines each in \`servers/validation/schemas.ts\`: a boolean \`Check\` plus the library's
error iterator, behind a \`~standard.validate\`. That a compiled JSON Schema checker
drops into a dunx route with no change to \`@dunx/http\` is the point of targeting an
interface rather than a library.

### Where dunx's own cost goes

${frameworkTable(report)}

The two \`manual\` rows declare no schemas and do the work inside the handler, which
keeps them on the synchronous dispatch path - so they separate dunx's **dispatch**
cost from its **input reader** cost. Dispatch is the second row minus the first.

The reader is the fourth row minus the third, and it is now at or below zero: the
framework's reader costs no more than writing \`validate(await req.json())\` in the
handler yourself. It used to cost **2.05 µs more**, which was twice what zod itself
cost - the reason is in
[\`docs/architecture/cost-of-validation.md\`](../../docs/architecture/cost-of-validation.md).
`;
};
