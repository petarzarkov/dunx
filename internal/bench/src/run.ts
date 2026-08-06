import { buildNodeEntries } from './build.js';
import { repoRoot, root } from './paths.js';
import { describeSubjects, readMachine } from './machine.js';
import { spread } from './stats.js';
import { bunCommand, startSubject, verifySubject } from './subject-process.js';
import {
  compileSubject,
  isNativeRuntime,
  probePython,
  probeToolchain,
  toolchainInfo,
  type NativeRuntime,
  type ToolchainStatus,
} from './toolchains.js';
import type {
  BenchConfig,
  LoadGenerator,
  Report,
  Scenario,
  ScenarioResult,
  StartupResult,
  Subject,
  ToolchainInfo,
} from './types.js';

const note = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const measureStartup = async (
  subject: Subject,
  exec: readonly string[],
  samples: number,
): Promise<StartupResult> => {
  const samplesMs: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const process_ = await startSubject(subject, exec);
    samplesMs.push(process_.startupMs);
    await process_.stop();
  }
  return { subject: subject.id, samplesMs, medianMs: spread(samplesMs).median };
};

const measureScenario = async (
  subject: Subject,
  scenario: Scenario,
  generator: LoadGenerator,
  config: BenchConfig,
  exec: readonly string[],
): Promise<ScenarioResult> => {
  // A fresh process per (subject, scenario) so no scenario inherits another's
  // warmed-up JIT state or heap.
  const server = await startSubject(subject, exec);
  try {
    await verifySubject(subject, server.baseUrl, [scenario]);
    const request = {
      url: `${server.baseUrl}${scenario.path}`,
      method: scenario.method,
      body: scenario.body,
      contentType: scenario.contentType,
    };
    const options = {
      connections: config.connections,
      durationSeconds: config.durationSeconds,
    };

    await generator.run(request, {
      ...options,
      durationSeconds: Math.max(
        config.warmupSeconds,
        subject.warmupFloorSeconds ?? 0,
      ),
    });

    const runs = [];
    for (let index = 0; index < config.runs; index += 1) {
      runs.push(await generator.run(request, options));
    }

    return {
      subject: subject.id,
      scenario: scenario.id,
      runs,
      rps: spread(runs.map((run) => run.rps)),
      latencyP50Ms: spread(runs.map((run) => run.latencyP50Ms)),
      latencyP99Ms: spread(runs.map((run) => run.latencyP99Ms)),
      totalErrors: runs.reduce((total, run) => total + run.errors, 0),
      totalNon2xx: runs.reduce((total, run) => total + run.non2xx, 0),
    };
  } finally {
    await server.stop();
  }
};

interface Prepared {
  readonly runnable: readonly Subject[];
  readonly exec: ReadonlyMap<string, readonly string[]>;
  readonly toolchains: readonly ToolchainInfo[];
}

/**
 * Resolves every subject to the argv that launches it, before anything is
 * measured: Bun runs from source, Node from a `Bun.build` transpile, and Go,
 * Rust and the JVM from an artifact compiled here. A subject whose toolchain is
 * missing is dropped with a line saying so, and the run continues.
 */
const prepare = async (
  chosen: readonly Subject[],
  nodeBinary: string,
  nodeAvailable: boolean,
): Promise<Prepared> => {
  const nodeEntries = await buildNodeEntries(chosen);
  const exec = new Map<string, readonly string[]>();
  const runnable: Subject[] = [];

  const wanted = [
    ...new Set(
      chosen
        .map((subject) => subject.runtime)
        .filter((runtime) => isNativeRuntime(runtime)),
    ),
  ];
  const statuses = new Map<NativeRuntime, ToolchainStatus>();
  for (const runtime of wanted)
    statuses.set(runtime, await probeToolchain(runtime));

  // Probed only when something asks for it, so a run without Django costs no
  // process spawn.
  const python = chosen.some((subject) => subject.runtime === 'python')
    ? await probePython()
    : null;

  const built = new Map<NativeRuntime, { ids: string[]; seconds: number }>();
  const skipped = new Map<NativeRuntime, string[]>();

  for (const subject of chosen) {
    if (subject.runtime === 'bun') {
      exec.set(subject.id, bunCommand(subject));
      runnable.push(subject);
      continue;
    }
    if (subject.runtime === 'node') {
      const entry = nodeEntries.get(subject.id);
      if (!nodeAvailable || entry === undefined) continue;
      exec.set(subject.id, [nodeBinary, entry]);
      runnable.push(subject);
      continue;
    }
    if (subject.runtime === 'python') {
      if (python === null || python.version === null) {
        note(
          `No importable Django for "${python?.binary ?? 'python3'}" - skipping ` +
            `${subject.label}. Set BENCH_PYTHON, or BENCH_PYTHONPATH at a ` +
            'directory holding an extracted Django wheel.',
        );
        continue;
      }
      // The subject process inherits `process.env`, and Python reads
      // `PYTHONPATH`, not `BENCH_PYTHONPATH`. Mapped here rather than threaded
      // through `exec`, which carries argv only.
      const path = python.env['PYTHONPATH'];
      if (path !== undefined) process.env['PYTHONPATH'] = path;

      exec.set(subject.id, [python.binary, `${root}/${subject.entry}`]);
      runnable.push(subject);
      continue;
    }
    if (!isNativeRuntime(subject.runtime)) continue;

    const status = statuses.get(subject.runtime);
    if (status === undefined || status.version === null) {
      skipped.set(subject.runtime, [
        ...(skipped.get(subject.runtime) ?? []),
        subject.label,
      ]);
      continue;
    }
    note(`Compiling ${subject.label} with ${status.version}`);
    const compiled = await compileSubject(subject, status);
    exec.set(subject.id, compiled.exec);
    runnable.push(subject);
    const tally = built.get(subject.runtime) ?? { ids: [], seconds: 0 };
    built.set(subject.runtime, {
      ids: [...tally.ids, subject.id],
      seconds: tally.seconds + compiled.seconds,
    });
  }

  for (const [runtime, labels] of skipped) {
    const status = statuses.get(runtime);
    note(
      `No ${status?.label ?? runtime} toolchain - skipping ${labels.join(', ')}. ${status?.hint ?? ''}`,
    );
  }

  const toolchains = [...statuses].map(([runtime, status]) => {
    const tally = built.get(runtime);
    return toolchainInfo(status, tally?.ids ?? [], tally?.seconds ?? 0);
  });

  return { runnable, exec, toolchains };
};

export const runSuite = async (
  chosenSubjects: readonly Subject[],
  chosenScenarios: readonly Scenario[],
  generator: LoadGenerator,
  config: BenchConfig,
  nodeBinary: string,
): Promise<Report> => {
  const machine = await readMachine(nodeBinary);
  if (machine.node === 'not found') {
    note(
      `No Node binary at "${nodeBinary}" - skipping the Node subjects. Set BENCH_NODE to include them.`,
    );
  }
  const { runnable, exec, toolchains } = await prepare(
    chosenSubjects,
    nodeBinary,
    machine.node !== 'not found',
  );

  const results: ScenarioResult[] = [];
  const startup: StartupResult[] = [];

  for (const subject of runnable) {
    const argv = exec.get(subject.id) ?? [];
    note(`\n${subject.label}`);
    startup.push(await measureStartup(subject, argv, config.startupSamples));
    note(
      `  startup  ${startup.at(-1)?.medianMs.toFixed(1) ?? '?'} ms (median)`,
    );
    for (const scenario of chosenScenarios) {
      const result = await measureScenario(
        subject,
        scenario,
        generator,
        config,
        argv,
      );
      results.push(result);
      note(
        `  ${scenario.id.padEnd(10)} ${Math.round(result.rps.median).toLocaleString('en-US').padStart(10)} req/s` +
          `  p99 ${result.latencyP99Ms.median.toFixed(3)} ms` +
          (result.totalErrors + result.totalNon2xx > 0
            ? `  errors ${result.totalErrors} non-2xx ${result.totalNon2xx}`
            : ''),
      );
    }
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    machine,
    loadGenerator: {
      id: generator.id,
      version: generator.version,
      // Repo-relative: this file is committed, and an absolute path would
      // publish whoever's machine generated it.
      binary:
        generator.binary === null
          ? null
          : generator.binary.replace(`${repoRoot}/`, ''),
      limitations: generator.limitations,
    },
    config,
    toolchains,
    subjects: await describeSubjects(runnable),
    scenarios: chosenScenarios,
    results,
    startup,
  };
};
