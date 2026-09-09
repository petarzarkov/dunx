/**
 * What Bun's own database and cache clients are worth against the two a Node
 * service reaches for, with everything else held still.
 *
 * The `io` scenario in `bun run start` cannot answer this on its own. Its Bun
 * subjects run `Bun.SQL` and `Bun.RedisClient` and its Node subjects run `pg` and
 * `ioredis`, so every gap there is a driver difference **and** a runtime
 * difference, and the two cannot be separated from one table.
 *
 * So this harness runs `pg` and `ioredis` **on Bun**, next to the native pair on
 * the same runtime, the same `Bun.serve`, the same SQL, the same pool size of 8
 * and the same bytes on the wire. Five cells:
 *
 * | cell            | runtime | Postgres     | Redis            |
 * | --------------- | ------- | ------------ | ---------------- |
 * | `bun:native`    | Bun     | `Bun.SQL`    | `Bun.RedisClient` |
 * | `bun:pg`        | Bun     | `pg`         | `Bun.RedisClient` |
 * | `bun:ioredis`   | Bun     | `Bun.SQL`    | `ioredis`        |
 * | `bun:classic`   | Bun     | `pg`         | `ioredis`        |
 * | `node:classic`  | Node    | `pg`         | `ioredis`        |
 *
 * The two middle cells split the total between the two clients, the way
 * `src/validation.ts` splits the validate scenario into parsing, validator and
 * framework. `node:classic` changes the runtime and the server as well and is the
 * reference point rather than a term in the comparison.
 *
 * ```bash
 * bun run drivers
 * bun run drivers --duration 6 --runs 5
 * ```
 */
import { parseArgs } from 'node:util';
import { buildNodeEntries } from './build.js';
import { driveUnits, note, num, type Live } from './driver.js';
import { ioServices, probeIo } from './io-fixture.js';
import { selectGenerator, type LoadGeneratorChoice } from './loadgen/index.js';
import { readMachine } from './machine.js';
import { resultsDir } from './paths.js';
import { pairRounds } from './resources.js';
import { median, spread } from './stats.js';
import { bunCommand, startSubject } from './subject-process.js';
import type { MachineInfo, Spread, Subject } from './types.js';

const MIB = 1024 * 1024;
const CONTRACT =
  '{"cached":"Hello, World!","id":1,"memo":"row 1","amount":100}';

interface Unit {
  readonly id: string;
  readonly label: string;
  readonly runtime: 'bun' | 'node';
  readonly sql: string;
  readonly redis: string;
  readonly env: Readonly<Record<string, string>>;
}

const units: readonly Unit[] = [
  {
    id: 'bun:native',
    label: 'Bun.SQL + Bun.RedisClient',
    runtime: 'bun',
    sql: 'Bun.SQL',
    redis: 'Bun.RedisClient',
    env: { BENCH_DRIVER_SQL: 'bun', BENCH_DRIVER_REDIS: 'bun' },
  },
  {
    id: 'bun:pg',
    label: 'pg + Bun.RedisClient',
    runtime: 'bun',
    sql: 'pg',
    redis: 'Bun.RedisClient',
    env: { BENCH_DRIVER_SQL: 'pg', BENCH_DRIVER_REDIS: 'bun' },
  },
  {
    id: 'bun:ioredis',
    label: 'Bun.SQL + ioredis',
    runtime: 'bun',
    sql: 'Bun.SQL',
    redis: 'ioredis',
    env: { BENCH_DRIVER_SQL: 'bun', BENCH_DRIVER_REDIS: 'ioredis' },
  },
  {
    id: 'bun:classic',
    label: 'pg + ioredis (on Bun)',
    runtime: 'bun',
    sql: 'pg',
    redis: 'ioredis',
    env: { BENCH_DRIVER_SQL: 'pg', BENCH_DRIVER_REDIS: 'ioredis' },
  },
  {
    id: 'node:classic',
    label: 'pg + ioredis (on Node)',
    runtime: 'node',
    sql: 'pg',
    redis: 'ioredis',
    env: {},
  },
];

const subjectFor = (unit: Unit): Subject => ({
  id: unit.id.replace(':', '-'),
  label: unit.label,
  runtime: unit.runtime,
  entry:
    unit.runtime === 'bun'
      ? 'servers/drivers/bun.ts'
      : 'servers/drivers/node.ts',
  preload: [],
  versionOf: null,
  validator: 'none',
  io: `${unit.sql} + ${unit.redis}`,
  notes: [],
});

interface Result {
  readonly id: string;
  readonly label: string;
  readonly runtime: string;
  readonly sql: string;
  readonly redis: string;
  readonly rps: Spread;
  readonly latencyP50Ms: Spread;
  readonly latencyP99Ms: Spread;
  readonly rssPeakMiB: number;
  readonly cpuMsPerKiloRequests: number;
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

const usage = `bun run drivers [options]

  --connections <n>      concurrent connections (default 64)
  --duration <seconds>   measured seconds per run (default 5)
  --warmup <seconds>     unmeasured seconds before each unit (default 3)
  --runs <n>             measured runs per unit (default 5)
  --loadgen <name>       auto | oha | fetch (default auto)
  --out <path>           JSON path (default results/drivers.json)
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
    'allow-fallback': { type: 'boolean' },
    out: { type: 'string' },
    help: { type: 'boolean' },
  },
  strict: true,
});

if (values.help === true) {
  console.log(usage);
  process.exit(0);
}

const config = {
  connections: num(values.connections, 64),
  durationSeconds: num(values.duration, 5),
  warmupSeconds: num(values.warmup, 3),
  runs: num(values.runs, 5),
};

const services = ioServices();

const nodeBinary = process.env['BENCH_NODE'] ?? 'node';
const machine = await readMachine(nodeBinary);
const nodeUnit = units.find((unit) => unit.runtime === 'node');
const nodeEntry =
  nodeUnit === undefined
    ? undefined
    : (await buildNodeEntries(units.map(subjectFor))).get(
        subjectFor(nodeUnit).id,
      );
if (machine.node === 'not found' || nodeEntry === undefined) {
  note(
    `No Node binary at "${nodeBinary}" - the node:classic cell will be missing. ` +
      'Set BENCH_NODE to include it.',
  );
}

// `machine.node` as well as the entry: `buildNodeEntries` is `Bun.build` and
// transpiles whether or not a Node binary exists, so the entry alone is not
// evidence that anything can run it. Without this the cell is brought up with a
// missing binary, `startSubject` throws, and `driveUnits` aborts the whole
// harness instead of returning the four Bun rows. `run.ts` has the same check.
const nodeUsable = machine.node !== 'not found' && nodeEntry !== undefined;
const runnable = units.filter((unit) => unit.runtime === 'bun' || nodeUsable);

// After `runnable`, not before: the connection budget has to be sized on the
// cells that will actually open a pool, or a machine with no Node is refused
// over connections nobody was going to ask for.
const probe = await probeIo(services, runnable.length);
if (!probe.ok) {
  note(
    `This harness is only about database and cache clients, so it cannot skip ` +
      `them the way the main suite skips the io scenario.\n${probe.reason}\n` +
      'Set BENCH_REDIS_URL and BENCH_PG_URL, or start the services.',
  );
  process.exit(1);
}

const generator = await selectGenerator(
  (values.loadgen ?? 'auto') as LoadGeneratorChoice,
  values['allow-fallback'] === true,
);

const bring = async (unit: Unit): Promise<Live<Unit>> => {
  const subject = subjectFor(unit);
  const exec =
    unit.runtime === 'bun'
      ? bunCommand(subject)
      : [nodeBinary, nodeEntry ?? ''];
  const server = await startSubject(subject, exec, {
    ...unit.env,
    BENCH_IO_PG_URL: services.pgUrl,
    BENCH_IO_REDIS_URL: services.redisUrl,
  });
  try {
    const answered = await (await fetch(`${server.baseUrl}/io`)).text();
    if (answered !== CONTRACT) {
      throw new Error(
        `${unit.id} answered ${JSON.stringify(answered)}, expected ${JSON.stringify(CONTRACT)}`,
      );
    }
    return {
      unit,
      server,
      request: { url: `${server.baseUrl}/io`, method: 'GET' },
      samples: [],
      usage: [],
    };
  } catch (error) {
    // `bring` owns what it starts until it returns - see `driveUnits`.
    await server.stop();
    throw error;
  }
};

/**
 * Interleaved round-robin, for the reason `db-modes.ts` records: the whole output
 * is the gap between rows that differ by one client, and this machine's
 * throughput drifts by more than such a gap over the minutes a run takes.
 */
const live = await driveUnits(runnable, bring, generator, config);

const collect = (entry: Live<Unit>): Result => {
  // The same pairing `run.ts` uses, from `resources.ts`, rather than a second
  // copy that can drift from it.
  const paired = pairRounds(entry.usage, entry.samples);
  return {
    id: entry.unit.id,
    label: entry.unit.label,
    runtime: entry.unit.runtime,
    sql: entry.unit.sql,
    redis: entry.unit.redis,
    rps: spread(entry.samples.map((sample) => sample.rps)),
    latencyP50Ms: spread(entry.samples.map((sample) => sample.latencyP50Ms)),
    latencyP99Ms: spread(entry.samples.map((sample) => sample.latencyP99Ms)),
    rssPeakMiB:
      paired.length === 0
        ? 0
        : Math.max(...paired.map((one) => one.sample.rssPeakBytes)) / MIB,
    cpuMsPerKiloRequests: median(
      paired
        .filter((one) => one.load.requests > 0)
        .map((one) => (one.sample.cpuMs / one.load.requests) * 1000),
    ),
    bad: entry.samples.reduce(
      (total, sample) => total + sample.non2xx + sample.errors,
      0,
    ),
  };
};

const results = live.map(collect);
const baseline = results.find((row) => row.id === 'bun:native')?.rps.median;

for (const result of results) {
  note(
    `${result.id.padEnd(13)} ${Math.round(result.rps.median).toLocaleString('en-US').padStart(9)} req/s` +
      `  sd ${Math.round(result.rps.stddev).toString().padStart(5)}` +
      `  p50 ${result.latencyP50Ms.median.toFixed(3)} ms` +
      `  p99 ${result.latencyP99Ms.median.toFixed(3)} ms` +
      `  rss ${result.rssPeakMiB.toFixed(0).padStart(4)} MiB` +
      `  cpu ${result.cpuMsPerKiloRequests.toFixed(2)} ms/kreq` +
      (baseline === undefined || baseline === 0
        ? ''
        : `  ${((result.rps.median / baseline) * 100).toFixed(1)}% of native`) +
      (result.bad > 0 ? `  BAD ${result.bad}` : ''),
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

const out = values.out ?? `${resultsDir}/drivers.json`;
await Bun.write(out, `${JSON.stringify(report, null, 2)}\n`);
note(`\nJSON report written to ${out}`);
