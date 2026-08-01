import { parseArgs } from 'node:util';
import { resultsDir } from './paths.js';
import type { LoadGeneratorChoice } from './loadgen/index.js';
import { scenarios } from './scenarios.js';
import { subjects } from './subjects.js';
import type { BenchConfig, Scenario, Subject } from './types.js';

export interface Options {
  readonly config: BenchConfig;
  readonly loadgen: LoadGeneratorChoice;
  readonly subjects: readonly Subject[];
  readonly scenarios: readonly Scenario[];
  readonly out: string;
  readonly nodeBinary: string;
}

export const usage = `bun run start [options]

  --connections <n>      concurrent connections (default 64)
  --duration <seconds>   measured seconds per run (default 5)
  --warmup <seconds>     unmeasured seconds before each scenario (default 3)
  --runs <n>             measured runs per scenario (default 5)
  --startup-samples <n>  cold starts timed per subject (default 7)
  --loadgen <name>       auto | oha | fetch (default auto: oha if installed)
  --subjects <a,b>       comma-separated subject ids (default all)
  --scenarios <a,b>      comma-separated scenario ids (default all)
  --out <path>           JSON report path (default results/latest.json)
  --help

  Subjects:  ${subjects.map((subject) => subject.id).join(', ')}
  Scenarios: ${scenarios.map((scenario) => scenario.id).join(', ')}
`;

const positive = (
  raw: string | undefined,
  fallback: number,
  name: string,
): number => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`--${name} must be a positive number`);
  return value;
};

const pick = <T extends { readonly id: string }>(
  all: readonly T[],
  raw: string | undefined,
  kind: string,
): readonly T[] => {
  if (raw === undefined) return all;
  const wanted = raw.split(',').map((entry) => entry.trim());
  return wanted.map((id) => {
    const found = all.find((entry) => entry.id === id);
    if (found === undefined) {
      throw new Error(
        `Unknown ${kind} "${id}". Known: ${all.map((e) => e.id).join(', ')}`,
      );
    }
    return found;
  });
};

const asChoice = (raw: string | undefined): LoadGeneratorChoice => {
  if (raw === undefined) return 'auto';
  if (raw === 'auto' || raw === 'oha' || raw === 'fetch') return raw;
  throw new Error(`--loadgen must be auto, oha or fetch (got "${raw}")`);
};

export const parseOptions = (argv: readonly string[]): Options | null => {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      connections: { type: 'string' },
      duration: { type: 'string' },
      warmup: { type: 'string' },
      runs: { type: 'string' },
      'startup-samples': { type: 'string' },
      loadgen: { type: 'string' },
      subjects: { type: 'string' },
      scenarios: { type: 'string' },
      out: { type: 'string' },
      help: { type: 'boolean' },
    },
    strict: true,
  });

  if (values.help === true) return null;

  return {
    config: {
      connections: positive(values.connections, 64, 'connections'),
      durationSeconds: positive(values.duration, 5, 'duration'),
      warmupSeconds: positive(values.warmup, 3, 'warmup'),
      runs: positive(values.runs, 5, 'runs'),
      startupSamples: positive(values['startup-samples'], 7, 'startup-samples'),
    },
    loadgen: asChoice(values.loadgen),
    subjects: pick(subjects, values.subjects, 'subject'),
    scenarios: pick(scenarios, values.scenarios, 'scenario'),
    out: values.out ?? `${resultsDir}/latest.json`,
    nodeBinary: process.env['BENCH_NODE'] ?? 'node',
  };
};
