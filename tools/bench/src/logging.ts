/**
 * The request-logging cost harness, a third runner alongside `start` and
 * `validation` and for the same reason: the main suite reports `dunx-logging` as
 * one number, and one number cannot say *which* part of writing a structured line
 * per request is expensive.
 *
 * Every unit is the same app on the same route. They differ only in how much of
 * the default logging path is present, so a row minus the row above it is that one
 * step's cost. `servers/logging/dunx.ts` holds the variants.
 *
 * ```bash
 * bun run logging
 * bun run logging --scenario validate
 * ```
 */
import { parseArgs } from 'node:util';
import { selectGenerator, type LoadGeneratorChoice } from './loadgen/index.js';
import { readMachine } from './machine.js';
import { resultsDir } from './paths.js';
import { scenarios } from './scenarios.js';
import { spread } from './stats.js';
import {
  startSubject,
  type StdoutSink,
  type SubjectProcess,
} from './subject-process.js';
import type {
  LoadRequest,
  LoadSample,
  LoggingReport,
  LoggingUnit,
  Scenario,
  Subject,
} from './types.js';

const subject: Subject = {
  id: 'dunx',
  label: '@dunx/http',
  runtime: 'bun',
  entry: 'servers/logging/dunx.ts',
  preload: ['@dunx/transform/preload'],
  versionOf: '@dunx/http',
  validator: 'zod (Standard Schema)',
  notes: [],
};

interface Unit {
  readonly id: string;
  readonly variant: string;
  readonly label: string;
  readonly adds: string;
  readonly stdout: StdoutSink;
}

/**
 * Ordered so each row adds exactly one thing to the row above it. `default` is the
 * shipped configuration; `default-blocked` is the same process with its stdout
 * going into a pipe nobody reads, which is a property of the consumer and not of
 * dunx - it is here because it is what the harness used to measure.
 */
const units: readonly Unit[] = [
  {
    id: 'off',
    variant: 'off',
    label: '`requestLogging: false`',
    adds: '-',
    stdout: 'null',
  },
  {
    id: 'passthru',
    variant: 'passthru',
    label: 'one middleware that only calls `next()`',
    adds: 'the chain, and losing direct dispatch',
    stdout: 'null',
  },
  {
    id: 'path',
    variant: 'path',
    label: '+ the pathname sliced out of `req.url`',
    adds: 'two `indexOf` and a `slice`',
    stdout: 'null',
  },
  {
    id: 'headers',
    variant: 'headers',
    label: '+ `x-request-id` and `user-agent` read',
    adds: '**first touch of `req.headers`**',
    stdout: 'null',
  },
  {
    id: 'requestid',
    variant: 'requestid',
    label: '+ `crypto.randomUUID()`',
    adds: 'the request id',
    stdout: 'null',
  },
  {
    id: 'als',
    variant: 'als',
    label: '+ `runWithContext` around the handler',
    adds: '`AsyncLocalStorage.run` and an async frame',
    stdout: 'null',
  },
  {
    id: 'respheader',
    variant: 'respheader',
    label: '+ `x-request-id` set on the response',
    adds: 'one `Headers.set`',
    stdout: 'null',
  },
  {
    id: 'entry',
    variant: 'entry',
    label: '+ the real middleware, `Logger` discards',
    adds: 'the query slice, the entry object, the timings',
    stdout: 'null',
  },
  {
    id: 'timestamp',
    variant: 'timestamp',
    label: '+ `new Date().toISOString()`',
    adds: 'the entry timestamp',
    stdout: 'null',
  },
  {
    id: 'serialize',
    variant: 'serialize',
    label: '+ the entry and `JSON.stringify`, string dropped',
    adds: 'building and serialising the line',
    stdout: 'null',
  },
  {
    id: 'unbatched',
    variant: 'unbatched',
    label: '+ one `console.log` per entry',
    adds: 'a `write(2)` per request - what dunx used to do',
    stdout: 'null',
  },
  {
    id: 'default',
    variant: 'default',
    label: 'batched instead - **the shipped default**',
    adds: 'one write per event-loop turn',
    stdout: 'null',
  },
  {
    id: 'default-blocked',
    variant: 'default',
    label: 'the default, into a pipe nobody reads',
    adds: 'kernel backpressure, not framework cost',
    stdout: 'blocked',
  },
  {
    id: 'unbatched-blocked',
    variant: 'unbatched',
    label: 'unbatched, into a pipe nobody reads',
    adds: 'what the main suite measured before either fix',
    stdout: 'blocked',
  },
];

const note = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

interface Live {
  readonly unit: Unit;
  readonly server: SubjectProcess;
  readonly request: LoadRequest;
  readonly samples: LoadSample[];
}

const bring = async (unit: Unit, scenario: Scenario): Promise<Live> => {
  const server = await startSubject(
    subject,
    'node',
    undefined,
    { LOGGING_VARIANT: unit.variant },
    unit.stdout,
  );
  const url = `${server.baseUrl}${scenario.path}`;
  const headers = {
    'content-type': scenario.contentType ?? 'application/json',
  };
  const probe = await fetch(url, {
    method: scenario.method,
    ...(scenario.body === undefined ? {} : { body: scenario.body, headers }),
  });
  const body = await probe.text();
  if (probe.status !== scenario.expectStatus || body !== scenario.expectBody) {
    await server.stop();
    throw new Error(
      `${unit.id} answered ${probe.status} ${JSON.stringify(body)}, expected ` +
        `${scenario.expectStatus} ${JSON.stringify(scenario.expectBody)}`,
    );
  }

  return {
    unit,
    server,
    request: {
      url,
      method: scenario.method,
      body: scenario.body,
      contentType: scenario.contentType,
    },
    samples: [],
  };
};

const collect = (live: Live): LoggingUnit => ({
  id: live.unit.id,
  label: live.unit.label,
  adds: live.unit.adds,
  stdout: live.unit.stdout,
  rps: spread(live.samples.map((sample) => sample.rps)),
  latencyP50Ms: spread(live.samples.map((sample) => sample.latencyP50Ms)),
  latencyP99Ms: spread(live.samples.map((sample) => sample.latencyP99Ms)),
  bad: live.samples.reduce(
    (total, sample) => total + sample.non2xx + sample.errors,
    0,
  ),
});

const usage = `bun run logging [options]

  --connections <n>      concurrent connections (default 64)
  --duration <seconds>   measured seconds per run (default 4)
  --warmup <seconds>     unmeasured seconds before each unit (default 3)
  --runs <n>             measured runs per unit (default 3)
  --loadgen <name>       auto | oha | fetch (default auto)
  --scenario <id>        ${scenarios.map((s) => s.id).join(' | ')} (default json)
  --out <path>           JSON path (default results/logging.json)
  --help
`;

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    connections: { type: 'string' },
    duration: { type: 'string' },
    warmup: { type: 'string' },
    runs: { type: 'string' },
    loadgen: { type: 'string' },
    scenario: { type: 'string' },
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

const chosenId = values.scenario ?? 'json';
const scenario = scenarios.find((entry) => entry.id === chosenId);
if (scenario === undefined) throw new Error(`Unknown scenario "${chosenId}"`);

const config = {
  connections: num(values.connections, 64),
  durationSeconds: num(values.duration, 4),
  warmupSeconds: num(values.warmup, 3),
  runs: num(values.runs, 3),
};

const generator = await selectGenerator(
  (values.loadgen ?? 'auto') as LoadGeneratorChoice,
);
const machine = await readMachine('node');

/**
 * Round-robin, for the reason `src/validation.ts` records: the differences here are
 * a few percent and the machine drifts by more than that over a run, so measuring
 * each unit to completion in turn maps the drift onto row identity.
 */
const live: Live[] = [];
try {
  for (const unit of units) {
    live.push(await bring(unit, scenario));
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
const baseline = results[0]?.rps.median ?? 0;
for (const result of results) {
  const micros = 1_000_000 / result.rps.median;
  note(
    `${result.id.padEnd(18)} ${Math.round(result.rps.median).toLocaleString('en-US').padStart(9)} req/s` +
      `  ${micros.toFixed(2)} µs` +
      `  +${(micros - 1_000_000 / baseline).toFixed(2)} µs vs off` +
      `  sd ${Math.round(result.rps.stddev).toString().padStart(5)}` +
      (result.bad > 0 ? `  BAD ${result.bad}` : ''),
  );
}

const report: LoggingReport = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  machine,
  loadGenerator: { id: generator.id, version: generator.version },
  config,
  scenario: scenario.id,
  units: results,
};

const out = values.out ?? `${resultsDir}/logging.json`;
await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
note(`\nJSON report written to ${out}`);
