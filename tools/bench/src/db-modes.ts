/**
 * What `@dunx/infra/db`'s synchronous SQLite mode is worth end to end, measured
 * through a real `Bun.serve` rather than around one.
 *
 * The claim being tested is narrow. `bun:sqlite` is synchronous underneath, so an
 * app that awaits its way to a row pays promise machinery for nothing; sync mode
 * removes it, and `@dunx/http`'s direct dispatch path means a handler returning a
 * plain value allocates no promise either. Whether that is visible above the noise
 * floor of an HTTP round trip is exactly the question, and the honest answer may be
 * "not on the read path".
 *
 * Two scenarios, four units:
 *
 * - `read` - one indexed `SELECT`, awaited (`async`) versus `.get()` (`sync`).
 * - `write` - two inserts and a count in one transaction: this package's
 *   `transaction()`, which issues `BEGIN`/`COMMIT` around an async callback and
 *   serialises overlapping ones through a queue, versus `transactionSync()`, which
 *   is `bun:sqlite`'s own native transaction.
 *
 * ```bash
 * bun run db-modes
 * bun run db-modes --duration 6 --runs 5
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
  MachineInfo,
  Scenario,
  Spread,
  Subject,
} from './types.js';

type Mode = 'async' | 'sync';

const subject = (mode: Mode): Subject => ({
  id: `db-${mode}`,
  label: `@dunx/infra/db (${mode})`,
  runtime: 'bun',
  entry: 'servers/db/sqlite.ts',
  preload: ['@dunx/transform/preload'],
  versionOf: '@dunx/infra',
  validator: 'none',
  notes: [],
});

const READ: Scenario = {
  id: 'read',
  title: 'GET /read',
  description: 'One indexed SELECT of a single row, serialised to JSON.',
  method: 'GET',
  path: '/read',
  expectStatus: 200,
  expectBody: '{"id":1,"memo":"row 0","amount":0}',
  expectMime: 'application/json',
};

const WRITE: Scenario = {
  id: 'write',
  title: 'POST /write',
  description: 'Two inserts and a count, in one transaction.',
  method: 'POST',
  path: '/write',
  expectStatus: 200,
  expectMime: 'application/json',
  // The row count grows with every request, so the body cannot be pinned.
  expectBody: '',
};

interface Unit {
  readonly id: string;
  readonly mode: Mode;
  readonly scenario: Scenario;
}

const units: readonly Unit[] = [
  { id: 'read:async', mode: 'async', scenario: READ },
  { id: 'read:sync', mode: 'sync', scenario: READ },
  { id: 'write:async', mode: 'async', scenario: WRITE },
  { id: 'write:sync', mode: 'sync', scenario: WRITE },
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

interface Result {
  readonly id: string;
  readonly scenario: string;
  readonly mode: Mode;
  readonly rps: Spread;
  readonly latencyP50Ms: Spread;
  readonly latencyP99Ms: Spread;
  readonly bad: number;
}

interface Report {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly machine: MachineInfo;
  readonly loadGenerator: { readonly id: string; readonly version: string };
  readonly config: {
    readonly connections: number;
    readonly durationSeconds: number;
    readonly warmupSeconds: number;
    readonly runs: number;
  };
  readonly units: readonly Result[];
}

/**
 * One process per mode, not one per unit: both scenarios are served by the same
 * app, and a second copy would double the SQLite files for no gain. The `read` and
 * `write` units of a mode therefore share a server, which is fine because the
 * generator drives one at a time.
 */
const servers = new Map<Mode, SubjectProcess>();

const bring = async (unit: Unit): Promise<Live> => {
  let server = servers.get(unit.mode);
  if (server === undefined) {
    server = await startSubject(subject(unit.mode), 'node', undefined, {
      DB_MODE: unit.mode,
    });
    servers.set(unit.mode, server);
  }

  const url = `${server.baseUrl}${unit.scenario.path}`;
  const probe = await fetch(url, { method: unit.scenario.method });
  const body = await probe.text();
  const matches =
    unit.scenario.expectBody === ''
      ? body.startsWith('{')
      : body === unit.scenario.expectBody;
  if (probe.status !== unit.scenario.expectStatus || !matches) {
    throw new Error(
      `${unit.id} answered ${probe.status} ${JSON.stringify(body)}, expected ` +
        `${unit.scenario.expectStatus} ${JSON.stringify(unit.scenario.expectBody)}`,
    );
  }

  return {
    unit,
    server,
    request: { url, method: unit.scenario.method },
    samples: [],
  };
};

const collect = (live: Live): Result => ({
  id: live.unit.id,
  scenario: live.unit.scenario.id,
  mode: live.unit.mode,
  rps: spread(live.samples.map((sample) => sample.rps)),
  latencyP50Ms: spread(live.samples.map((sample) => sample.latencyP50Ms)),
  latencyP99Ms: spread(live.samples.map((sample) => sample.latencyP99Ms)),
  bad: live.samples.reduce(
    (total, sample) => total + sample.non2xx + sample.errors,
    0,
  ),
});

const usage = `bun run db-modes [options]

  --connections <n>      concurrent connections (default 64)
  --duration <seconds>   measured seconds per run (default 4)
  --warmup <seconds>     unmeasured seconds before each unit (default 3)
  --runs <n>             measured runs per unit (default 5)
  --loadgen <name>       auto | oha | fetch (default auto)
  --out <path>           JSON path (default results/db-modes.json)
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

const config = {
  connections: num(values.connections, 64),
  durationSeconds: num(values.duration, 4),
  warmupSeconds: num(values.warmup, 3),
  runs: num(values.runs, 5),
};

const generator = await selectGenerator(
  (values.loadgen ?? 'auto') as LoadGeneratorChoice,
);
const machine = await readMachine('node');

/**
 * Interleaved round-robin, for the reason `validation.ts` records: the whole output
 * is the gap between two rows that differ by one step of work, and this machine's
 * throughput drifts by more than such a gap over the minutes a run takes. Measuring
 * each unit to completion in turn would map that drift onto unit identity.
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
  for (const server of servers.values()) await server.stop();
}

const results = live.map(collect);
for (const result of results) {
  note(
    `${result.id.padEnd(14)} ${Math.round(result.rps.median).toLocaleString('en-US').padStart(10)} req/s` +
      `  sd ${Math.round(result.rps.stddev).toString().padStart(5)}` +
      `  p50 ${result.latencyP50Ms.median.toFixed(3)} ms` +
      `  p99 ${result.latencyP99Ms.median.toFixed(3)} ms` +
      (result.bad > 0 ? `  BAD ${result.bad}` : ''),
  );
}

for (const scenario of ['read', 'write']) {
  const asyncRow = results.find(
    (row) => row.scenario === scenario && row.mode === 'async',
  );
  const syncRow = results.find(
    (row) => row.scenario === scenario && row.mode === 'sync',
  );
  if (asyncRow === undefined || syncRow === undefined) continue;
  const gain = (syncRow.rps.median / asyncRow.rps.median - 1) * 100;
  note(
    `${scenario.padEnd(6)} sync is ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}% req/s, ` +
      `p50 ${(syncRow.latencyP50Ms.median - asyncRow.latencyP50Ms.median).toFixed(3)} ms, ` +
      `p99 ${(syncRow.latencyP99Ms.median - asyncRow.latencyP99Ms.median).toFixed(3)} ms`,
  );
}

const report: Report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  machine,
  loadGenerator: { id: generator.id, version: generator.version },
  config,
  units: results,
};

const out = values.out ?? `${resultsDir}/db-modes.json`;
await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
note(`\nJSON report written to ${out}`);
