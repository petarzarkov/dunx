/**
 * The validation-cost harness, separate from `bun run start` because it answers two
 * questions the main suite deliberately cannot.
 *
 * The main suite holds the validator constant at zod so `validate` minus `json` is
 * readable as one framework's plumbing. That leaves two costs folded together:
 *
 * 1. **What parsing and validating cost at all** - the ~36% drop from `json` to
 *    `validate` that every subject pays. `servers/validation/raw.ts` splits it into
 *    transport, `req.json()` and the validator, on raw `Bun.serve`.
 * 2. **What each validator costs** through the same Standard Schema seam, in the
 *    same dunx app, on the same schema shape - so a user can pick one on evidence.
 *
 * ```bash
 * bun run validation                      # everything
 * bun run validation --validators zod,valibot
 * ```
 */
import { parseArgs } from 'node:util';
import { selectGenerator, type LoadGeneratorChoice } from './loadgen/index.js';
import { readMachine } from './machine.js';
import { resultsDir } from './paths.js';
import { spread } from './stats.js';
import { startSubject, type SubjectProcess } from './subject-process.js';
import type {
  LoadRequest,
  LoadSample,
  Scenario,
  Subject,
  ValidationReport,
  ValidationUnit,
} from './types.js';
import { VALIDATE_BODY } from './scenarios.js';
import {
  validatorIds,
  type ValidatorId,
} from '../servers/validation/schemas.js';

const EXPECT_BODY = '{"name":"Ada Lovelace","age":36}';

const rawSubject: Subject = {
  id: 'raw',
  label: 'Bun.serve (raw)',
  runtime: 'bun',
  entry: 'servers/validation/raw.ts',
  preload: [],
  versionOf: null,
  validator: 'varies',
  notes: [],
};

const dunxSubject: Subject = {
  id: 'dunx',
  label: '@dunx/http',
  runtime: 'bun',
  entry: 'servers/validation/dunx.ts',
  preload: ['@dunx/transform/preload'],
  versionOf: '@dunx/http',
  validator: 'varies',
  notes: [],
};

/** One measured cell: a server variant, a path, and what it must answer. */
interface Unit {
  readonly id: string;
  readonly group: 'decompose' | 'validator';
  readonly label: string;
  readonly subject: Subject;
  readonly validator: ValidatorId;
  readonly scenario: Scenario;
}

const jsonScenario: Scenario = {
  id: 'json',
  title: 'JSON',
  description: 'GET, no request body at all.',
  method: 'GET',
  path: '/json',
  expectStatus: 200,
  expectBody: '{"message":"Hello, World!"}',
  expectMime: 'application/json',
};

const postScenario = (path: string, description: string): Scenario => ({
  id: path.slice(1),
  title: path,
  description,
  method: 'POST',
  path,
  body: VALIDATE_BODY,
  contentType: 'application/json',
  expectStatus: 200,
  expectBody: EXPECT_BODY,
  expectMime: 'application/json',
});

const unitsFor = (chosen: readonly ValidatorId[]): readonly Unit[] => {
  const decompose: Unit[] = [
    {
      id: 'raw:json',
      group: 'decompose',
      label: 'GET /json - no body on the wire',
      subject: rawSubject,
      validator: 'noop',
      scenario: jsonScenario,
    },
    {
      id: 'raw:discard',
      group: 'decompose',
      label: 'POST, body sent and never read',
      subject: rawSubject,
      validator: 'noop',
      scenario: postScenario(
        '/discard',
        'POST with the body on the wire, never read. Adds transport only.',
      ),
    },
    {
      id: 'raw:parse',
      group: 'decompose',
      label: 'POST + await req.json()',
      subject: rawSubject,
      validator: 'noop',
      scenario: postScenario('/parse', 'POST, body parsed with req.json().'),
    },
    {
      id: 'dunx:manual-parse',
      group: 'decompose',
      label: 'dunx, no schemas, handler parses',
      subject: dunxSubject,
      validator: 'noop',
      scenario: postScenario(
        '/manual-parse',
        'dunx with no declared schemas, so the synchronous dispatch path, parsing in the handler.',
      ),
    },
    {
      id: 'dunx:manual-validate',
      group: 'decompose',
      label: 'dunx, no schemas, handler validates',
      subject: dunxSubject,
      validator: 'zod',
      scenario: postScenario(
        '/manual-validate',
        'dunx with no declared schemas, parsing and validating in the handler.',
      ),
    },
  ];

  const validate = postScenario(
    '/validate',
    'POST, body parsed and validated, echoed back.',
  );

  const perValidator = chosen.flatMap((validator): Unit[] => [
    {
      id: `raw:${validator}`,
      group: 'validator',
      label: validator,
      subject: rawSubject,
      validator,
      scenario: validate,
    },
    {
      id: `dunx:${validator}`,
      group: 'validator',
      label: validator,
      subject: dunxSubject,
      validator,
      scenario: validate,
    },
  ]);

  return [...decompose, ...perValidator];
};

const note = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

interface Live {
  readonly unit: Unit;
  readonly server: SubjectProcess;
  readonly request: LoadRequest;
  readonly samples: LoadSample[];
}

/**
 * Spawns the unit, checks it answers the exact expected bytes, and warms it up.
 * The process is then left running, because the measured rounds are interleaved.
 */
const bring = async (unit: Unit): Promise<Live> => {
  const server = await startSubject(unit.subject, 'node', undefined, {
    VALIDATOR: unit.validator,
  });
  const url = `${server.baseUrl}${unit.scenario.path}`;
  const headers = { 'content-type': 'application/json' };
  const probe = await fetch(url, {
    method: unit.scenario.method,
    ...(unit.scenario.body === undefined
      ? {}
      : { body: unit.scenario.body, headers }),
  });
  const body = await probe.text();
  if (probe.status !== 200 || body !== unit.scenario.expectBody) {
    await server.stop();
    throw new Error(
      `${unit.id} answered ${probe.status} ${JSON.stringify(body)}, expected 200 ` +
        JSON.stringify(unit.scenario.expectBody),
    );
  }

  return {
    unit,
    server,
    request: {
      url,
      method: unit.scenario.method,
      body: unit.scenario.body,
      contentType: unit.scenario.contentType,
    },
    samples: [],
  };
};

const collect = (live: Live): ValidationUnit => ({
  id: live.unit.id,
  group: live.unit.group,
  label: live.unit.label,
  subject: live.unit.subject.id,
  validator: live.unit.validator,
  path: live.unit.scenario.path,
  rps: spread(live.samples.map((sample) => sample.rps)),
  latencyP50Ms: spread(live.samples.map((sample) => sample.latencyP50Ms)),
  latencyP99Ms: spread(live.samples.map((sample) => sample.latencyP99Ms)),
  bad: live.samples.reduce(
    (total, sample) => total + sample.non2xx + sample.errors,
    0,
  ),
});

const usage = `bun run validation [options]

  --connections <n>      concurrent connections (default 64)
  --duration <seconds>   measured seconds per run (default 4)
  --warmup <seconds>     unmeasured seconds before each unit (default 3)
  --runs <n>             measured runs per unit (default 3)
  --loadgen <name>       auto | oha | fetch (default auto)
  --validators <a,b>     comma-separated (default all)
  --out <path>           JSON path (default results/validation.json)
  --help

  Validators: ${validatorIds.join(', ')}
`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    connections: { type: 'string' },
    duration: { type: 'string' },
    warmup: { type: 'string' },
    runs: { type: 'string' },
    loadgen: { type: 'string' },
    'allow-fallback': { type: 'boolean' },
    validators: { type: 'string' },
    out: { type: 'string' },
    help: { type: 'boolean' },
  },
  strict: true,
});

if (values.help === true) {
  console.log(usage);
  process.exit(0);
}

const num = (raw: string | undefined, fallback: number): number =>
  raw === undefined ? fallback : Number(raw);

const chosen: readonly ValidatorId[] =
  values.validators === undefined
    ? validatorIds
    : values.validators.split(',').map((raw) => {
        const id = raw.trim();
        if (!(validatorIds as readonly string[]).includes(id)) {
          throw new Error(`Unknown validator "${id}"`);
        }
        return id as ValidatorId;
      });

const config = {
  connections: num(values.connections, 64),
  durationSeconds: num(values.duration, 4),
  warmupSeconds: num(values.warmup, 3),
  runs: num(values.runs, 3),
};

const generator = await selectGenerator(
  (values.loadgen ?? 'auto') as LoadGeneratorChoice,
  values['allow-fallback'] === true,
);
const machine = await readMachine('node');
const units = unitsFor(chosen);

/**
 * All units are brought up first and then measured **round-robin**, which the
 * framework suite does not need to do and this one does. Its whole output is the
 * difference between rows that differ by one step of work - often 2-4% - and the
 * machine's own throughput drifts by more than that over the minutes a run takes.
 * Measuring each unit to completion in turn maps that drift onto unit identity: the
 * first attempt at this had `raw:parse` come out *slower* than `raw:noop`, which does
 * strictly more work. Interleaving spreads the drift across every row instead.
 */
const live: Live[] = [];
try {
  for (const unit of units) {
    live.push(await bring(unit));
    note(`up   ${unit.id}`);
  }

  const options = {
    connections: config.connections,
    durationSeconds: config.durationSeconds,
  };
  for (const entry of live) {
    await generator.run(entry.request, {
      ...options,
      durationSeconds: config.warmupSeconds,
    });
  }

  for (let round = 0; round < config.runs; round += 1) {
    note(`round ${round + 1} of ${config.runs}`);
    for (const entry of live) {
      entry.samples.push(await generator.run(entry.request, options));
    }
  }
} finally {
  for (const entry of live) await entry.server.stop();
}

const results = live.map(collect);
for (const result of results) {
  note(
    `${result.id.padEnd(22)} ${Math.round(result.rps.median).toLocaleString('en-US').padStart(10)} req/s` +
      `  sd ${Math.round(result.rps.stddev).toString().padStart(5)}` +
      `  p99 ${result.latencyP99Ms.median.toFixed(3)} ms` +
      (result.bad > 0 ? `  BAD ${result.bad}` : ''),
  );
}

const report: ValidationReport = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  machine,
  loadGenerator: { id: generator.id, version: generator.version },
  config,
  units: results,
};

const out = values.out ?? `${resultsDir}/validation.json`;
await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
note(`\nJSON report written to ${out}`);
