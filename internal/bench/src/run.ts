import { buildNodeEntries } from './build.js';
import { repoRoot, root } from './paths.js';
import { describeSubjects, readMachine } from './machine.js';
import { spread } from './stats.js';
import {
  bunCommand,
  type ProfileKind,
  startSubject,
  verifySubject,
  type SubjectProcess,
} from './subject-process.js';
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
  LoadRequest,
  LoadSample,
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
    const process_ = await startSubject(subject, exec, subject.env ?? {});
    samplesMs.push(process_.startupMs);
    await process_.stop();
  }
  return { subject: subject.id, samplesMs, medianMs: spread(samplesMs).median };
};

const summarise = (
  subject: Subject,
  scenario: Scenario,
  runs: readonly LoadSample[],
): ScenarioResult => ({
  subject: subject.id,
  scenario: scenario.id,
  runs: [...runs],
  rps: spread(runs.map((run) => run.rps)),
  latencyP50Ms: spread(runs.map((run) => run.latencyP50Ms)),
  latencyP99Ms: spread(runs.map((run) => run.latencyP99Ms)),
  totalErrors: runs.reduce((total, run) => total + run.errors, 0),
  totalNon2xx: runs.reduce((total, run) => total + run.non2xx, 0),
});

/**
 * Measures one scenario across **every** subject, interleaved: all subjects are
 * brought up and warmed first, then each measured round visits every one of them
 * in turn.
 *
 * **This is the drift defence, and the suite used to lack it.** Measuring each
 * subject to completion in turn spreads a full run over tens of minutes and maps
 * whatever the machine does in that time onto subject identity - `bun-serve`
 * measured first and `django` measured forty minutes later, with their ratio
 * reported as if the two numbers were simultaneous. Measured: two sequential runs
 * of identical code disagreed by a median of 3.9% and up to 10.1%, and 15 of 20
 * cells moved the *same* direction, which is drift rather than sampling noise. The
 * headline number this harness exists for - `@dunx/http` against raw `Bun.serve` -
 * is a 0.1% to 8% gap, so it sat entirely inside that.
 *
 * `validation.ts`, `logging.ts` and `db-modes.ts` all interleaved from the start,
 * for differences their comments describe as "often 2-4%". This is the same
 * argument arriving at the suite whose differences got small enough to need it.
 *
 * A fresh process per (subject, scenario) is preserved: nothing inherits another
 * scenario's warmed-up JIT state or heap, and a subject with a warmup floor (the
 * JVM and the two .NET rows) still pays it once rather than once per round.
 */
const measureScenarioAcrossSubjects = async (
  subjects: readonly Subject[],
  scenario: Scenario,
  generator: LoadGenerator,
  config: BenchConfig,
  exec: ReadonlyMap<string, readonly string[]>,
  profile?: { readonly kind: ProfileKind; readonly dir: string },
): Promise<readonly ScenarioResult[]> => {
  const options = {
    connections: config.connections,
    durationSeconds: config.durationSeconds,
  };
  const live: {
    subject: Subject;
    server: SubjectProcess;
    request: LoadRequest;
    runs: LoadSample[];
  }[] = [];

  try {
    // Brought up one at a time rather than concurrently: `freePort()` binds port
    // zero, reads the number and closes, so two subjects racing that probe can be
    // handed the same port.
    for (const subject of subjects) {
      const server = await startSubject(
        subject,
        exec.get(subject.id) ?? [],
        subject.env ?? {},
        'null',
        // Only the measured runs are worth profiling, and only a graceful stop
        // writes one. The startup samples above stay on SIGKILL: they start and
        // stop the subject seven times and would overwrite the profile with a
        // recording of nothing but boot.
        profile !== undefined,
      );
      await verifySubject(subject, server.baseUrl, [scenario]);
      live.push({
        subject,
        server,
        request: {
          url: `${server.baseUrl}${scenario.path}`,
          method: scenario.method,
          body: scenario.body,
          contentType: scenario.contentType,
        },
        runs: [],
      });
    }

    for (const entry of live) {
      await generator.run(entry.request, {
        ...options,
        durationSeconds: Math.max(
          config.warmupSeconds,
          entry.subject.warmupFloorSeconds ?? 0,
        ),
      });
    }

    for (let round = 0; round < config.runs; round += 1) {
      for (const entry of live) {
        entry.runs.push(await generator.run(entry.request, options));
      }
    }

    return live.map((entry) => summarise(entry.subject, scenario, entry.runs));
  } finally {
    for (const entry of live) await entry.server.stop();
  }
};

interface Prepared {
  readonly runnable: readonly Subject[];
  readonly exec: ReadonlyMap<string, readonly string[]>;
  readonly toolchains: readonly ToolchainInfo[];
  /** Package versions read out of the interpreter, for the `python` subjects. */
  readonly pythonVersions: ReadonlyMap<string, string | null> | undefined;
}

/**
 * Resolves every subject to the argv that launches it, before anything is
 * measured: Bun runs from source, Node from a `Bun.build` transpile, and Go,
 * Rust, the JVM and .NET from an artifact compiled here. A subject whose
 * toolchain is missing is dropped with a line saying so, and the run continues.
 */
const prepare = async (
  chosen: readonly Subject[],
  nodeBinary: string,
  nodeAvailable: boolean,
  profile?: { readonly kind: ProfileKind; readonly dir: string },
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

  // Probed only for the packages the chosen subjects actually need, so a run
  // without a Python subject costs no process spawn and a run with one does not
  // pay for the other's dependencies.
  const pythonPackages = chosen
    .filter((subject) => subject.runtime === 'python')
    .map((subject) => subject.requires ?? subject.id);
  const python =
    pythonPackages.length > 0 ? await probePython(pythonPackages) : null;

  const built = new Map<NativeRuntime, { ids: string[]; seconds: number }>();
  const skipped = new Map<NativeRuntime, string[]>();

  for (const subject of chosen) {
    if (subject.runtime === 'bun') {
      // Only a Bun subject can take Bun's profiler flags, so `--profile` is
      // applied here rather than around every spawn.
      exec.set(subject.id, bunCommand(subject, profile));
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
      const needs = subject.requires ?? subject.id;
      if (python === null || python.versions.get(needs) == null) {
        note(
          `No importable ${needs} for "${python?.binary ?? 'python3'}" - skipping ` +
            `${subject.label}. Set BENCH_PYTHON, or BENCH_PYTHONPATH at a ` +
            `directory holding an extracted ${needs} wheel.`,
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

  return { runnable, exec, toolchains, pythonVersions: python?.versions };
};

export const runSuite = async (
  chosenSubjects: readonly Subject[],
  chosenScenarios: readonly Scenario[],
  generator: LoadGenerator,
  config: BenchConfig,
  nodeBinary: string,
  profile?: { readonly kind: ProfileKind; readonly dir: string },
): Promise<Report> => {
  const machine = await readMachine(nodeBinary);
  if (machine.node === 'not found') {
    note(
      `No Node binary at "${nodeBinary}" - skipping the Node subjects. Set BENCH_NODE to include them.`,
    );
  }
  const { runnable, exec, toolchains, pythonVersions } = await prepare(
    chosenSubjects,
    nodeBinary,
    machine.node !== 'not found',
    profile,
  );

  const results: ScenarioResult[] = [];
  const startup: StartupResult[] = [];

  // Startup first and on its own: it spawns and stops one process at a time by
  // definition, so it cannot be interleaved and does not need to be. Doing it
  // before any load means no measured round shares the machine with a cold start.
  for (const subject of runnable) {
    const measured = await measureStartup(
      subject,
      exec.get(subject.id) ?? [],
      config.startupSamples,
    );
    startup.push(measured);
    note(
      `startup  ${subject.label} ${measured.medianMs.toFixed(1)} ms (median)`,
    );
  }

  for (const scenario of chosenScenarios) {
    note(`\n${scenario.id} - ${runnable.length} subjects, interleaved`);
    const measured = await measureScenarioAcrossSubjects(
      runnable,
      scenario,
      generator,
      config,
      exec,
      profile,
    );
    results.push(...measured);
    for (const result of measured) {
      const subject = runnable.find((one) => one.id === result.subject);
      note(
        `  ${(subject?.label ?? result.subject).padEnd(30)} ${Math.round(result.rps.median).toLocaleString('en-US').padStart(10)} req/s` +
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
    // The probe's versions are passed through because `node_modules` holds no
    // Python package, so `packageVersion` would report `unknown` for both rows.
    subjects: await describeSubjects(runnable, pythonVersions),
    scenarios: chosenScenarios,
    results,
    startup,
  };
};
