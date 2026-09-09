import { buildNodeEntries } from './build.js';
import { ioEnvFor, planIo } from './io-fixture.js';
import { repoRoot, root } from './paths.js';
import { describeSubjects, readMachine } from './machine.js';
import { ResourceSampler, type ResourceSample } from './resources.js';
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
  ResourceUsage,
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

const MIB = 1024 * 1024;

/**
 * Paired with the load samples by index: round `n`'s CPU is divided by round
 * `n`'s request count, never by a median of the other rounds. A round the
 * sampler could not read is dropped from both sides rather than paired with the
 * wrong one.
 */
const summariseResources = (
  subject: Subject,
  scenario: Scenario,
  runs: readonly LoadSample[],
  usage: readonly (ResourceSample | null)[],
  rssBootBytes: number | null,
): ResourceUsage | null => {
  const paired = usage
    .map((sample, index) => ({ sample, load: runs[index] }))
    .filter(
      (entry): entry is { sample: ResourceSample; load: LoadSample } =>
        entry.sample !== null && entry.load !== undefined,
    );
  if (paired.length === 0) return null;

  return {
    subject: subject.id,
    scenario: scenario.id,
    rssBootMiB: rssBootBytes === null ? null : rssBootBytes / MIB,
    rssPeakMiB: spread(paired.map((one) => one.sample.rssPeakBytes / MIB)),
    rssMeanMiB: spread(paired.map((one) => one.sample.rssMeanBytes / MIB)),
    cpuPercent: spread(
      paired.map((one) => (one.sample.cpuMs / one.sample.elapsedMs) * 100),
    ),
    cpuMsPerKiloRequests: spread(
      paired
        .filter((one) => one.load.requests > 0)
        .map((one) => (one.sample.cpuMs / one.load.requests) * 1000),
    ),
    processes: Math.max(...paired.map((one) => one.sample.processes)),
  };
};

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
  extraEnv: Readonly<Record<string, string>>,
  profile?: { readonly kind: ProfileKind; readonly dir: string },
): Promise<{
  readonly results: readonly ScenarioResult[];
  readonly resources: readonly ResourceUsage[];
}> => {
  const options = {
    connections: config.connections,
    durationSeconds: config.durationSeconds,
  };
  const live: {
    subject: Subject;
    server: SubjectProcess;
    request: LoadRequest;
    runs: LoadSample[];
    usage: (ResourceSample | null)[];
  }[] = [];

  try {
    // Brought up one at a time rather than concurrently: `freePort()` binds port
    // zero, reads the number and closes, so two subjects racing that probe can be
    // handed the same port.
    for (const subject of subjects) {
      const server = await startSubject(
        subject,
        exec.get(subject.id) ?? [],
        extraEnv,
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
        usage: [],
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
        // Started and stopped around this one subject's own window, so a
        // reading never spans another subject's turn. The sampler reads
        // `/proc` at 20 Hz, which is under a millisecond of work per second.
        const sampler = new ResourceSampler(entry.server.pid);
        sampler.start();
        try {
          entry.runs.push(await generator.run(entry.request, options));
        } finally {
          entry.usage.push(sampler.stop());
        }
      }
    }

    return {
      results: live.map((entry) =>
        summarise(entry.subject, scenario, entry.runs),
      ),
      resources: live
        .map((entry) =>
          summariseResources(
            entry.subject,
            scenario,
            entry.runs,
            entry.usage,
            entry.server.rssBootBytes,
          ),
        )
        .filter((one): one is ResourceUsage => one !== null),
    };
  } finally {
    for (const entry of live) await entry.server.stop();
  }
};

export interface Prepared {
  readonly runnable: readonly Subject[];
  readonly exec: ReadonlyMap<string, readonly string[]>;
  /**
   * The same commands with the profiler flags removed, for the startup samples.
   * Identical to `exec` unless `--profile` is set.
   *
   * `--cpu-prof` costs sampling overhead whether or not a profile is ever
   * written, so timing seven cold starts under it would report a startup median
   * that is an artefact of the measurement.
   */
  readonly startupExec: ReadonlyMap<string, readonly string[]>;
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
export const prepare = async (
  chosen: readonly Subject[],
  nodeBinary: string,
  nodeAvailable: boolean,
  profile?: { readonly kind: ProfileKind; readonly dir: string },
): Promise<Prepared> => {
  const nodeEntries = await buildNodeEntries(chosen);
  const exec = new Map<string, readonly string[]>();
  const startupExec = new Map<string, readonly string[]>();
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
      startupExec.set(subject.id, bunCommand(subject));
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

  // Every other runtime is unprofiled either way, so its startup command is the
  // one it already has.
  for (const [id, command] of exec) {
    if (!startupExec.has(id)) startupExec.set(id, command);
  }

  return {
    runnable,
    exec,
    startupExec,
    toolchains,
    pythonVersions: python?.versions,
  };
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
  const { runnable, exec, startupExec, toolchains, pythonVersions } =
    await prepare(
      chosenSubjects,
      nodeBinary,
      machine.node !== 'not found',
      profile,
    );

  // `runnable`, not `chosenSubjects`: a subject whose toolchain is missing opens
  // no pool, and counting it would refuse the scenario over connections nobody
  // was going to ask for.
  const plan = await planIo(chosenScenarios, runnable.length);
  if (plan.note !== null) note(plan.note);
  const scenarios = plan.scenarios;

  const results: ScenarioResult[] = [];
  const resources: ResourceUsage[] = [];
  const startup: StartupResult[] = [];

  // Startup first and on its own: it spawns and stops one process at a time by
  // definition, so it cannot be interleaved and does not need to be. Doing it
  // before any load means no measured round shares the machine with a cold start.
  for (const subject of runnable) {
    const measured = await measureStartup(
      subject,
      // Unprofiled: profiler overhead would land in the startup median.
      startupExec.get(subject.id) ?? [],
      config.startupSamples,
    );
    startup.push(measured);
    note(
      `startup  ${subject.label} ${measured.medianMs.toFixed(1)} ms (median)`,
    );
  }

  for (const scenario of scenarios) {
    note(`\n${scenario.id} - ${runnable.length} subjects, interleaved`);
    const measured = await measureScenarioAcrossSubjects(
      runnable,
      scenario,
      generator,
      config,
      exec,
      ioEnvFor(scenario, plan.services),
      profile,
    );
    results.push(...measured.results);
    resources.push(...measured.resources);
    for (const result of measured.results) {
      const subject = runnable.find((one) => one.id === result.subject);
      const cost = measured.resources.find(
        (one) => one.subject === result.subject,
      );
      note(
        `  ${(subject?.label ?? result.subject).padEnd(30)} ${Math.round(result.rps.median).toLocaleString('en-US').padStart(10)} req/s` +
          `  p99 ${result.latencyP99Ms.median.toFixed(3)} ms` +
          (cost === undefined
            ? ''
            : `  rss ${cost.rssPeakMiB.median.toFixed(0).padStart(4)} MiB` +
              `  cpu ${cost.cpuMsPerKiloRequests.median.toFixed(2)} ms/kreq`) +
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
    scenarios,
    results,
    resources,
    startup,
  };
};
