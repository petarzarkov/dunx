import { buildNodeEntries } from './build.js';
import { describeSubjects, readMachine } from './machine.js';
import { spread } from './stats.js';
import { startSubject, verifySubject } from './subject-process.js';
import type {
  BenchConfig,
  LoadGenerator,
  Report,
  Scenario,
  ScenarioResult,
  StartupResult,
  Subject,
} from './types.js';

const note = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const measureStartup = async (
  subject: Subject,
  nodeBinary: string,
  nodeEntry: string | undefined,
  samples: number,
): Promise<StartupResult> => {
  const samplesMs: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const process_ = await startSubject(subject, nodeBinary, nodeEntry);
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
  nodeBinary: string,
  nodeEntry: string | undefined,
): Promise<ScenarioResult> => {
  // A fresh process per (subject, scenario) so no scenario inherits another's
  // warmed-up JIT state or heap.
  const server = await startSubject(subject, nodeBinary, nodeEntry);
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
      durationSeconds: config.warmupSeconds,
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

export const runSuite = async (
  chosenSubjects: readonly Subject[],
  chosenScenarios: readonly Scenario[],
  generator: LoadGenerator,
  config: BenchConfig,
  nodeBinary: string,
): Promise<Report> => {
  const nodeEntries = await buildNodeEntries(chosenSubjects);
  const machine = await readMachine(nodeBinary);

  let runnable = chosenSubjects;
  if (machine.node === 'not found') {
    runnable = chosenSubjects.filter((subject) => subject.runtime === 'bun');
    note(
      `No Node binary at "${nodeBinary}" — skipping the Node subjects. Set BENCH_NODE to include them.`,
    );
  }

  const results: ScenarioResult[] = [];
  const startup: StartupResult[] = [];

  for (const subject of runnable) {
    const entry = nodeEntries.get(subject.id);
    note(`\n${subject.label}`);
    startup.push(
      await measureStartup(subject, nodeBinary, entry, config.startupSamples),
    );
    note(
      `  startup  ${startup.at(-1)?.medianMs.toFixed(1) ?? '?'} ms (median)`,
    );
    for (const scenario of chosenScenarios) {
      const result = await measureScenario(
        subject,
        scenario,
        generator,
        config,
        nodeBinary,
        entry,
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
      binary: generator.binary,
      limitations: generator.limitations,
    },
    config,
    subjects: await describeSubjects(runnable),
    scenarios: chosenScenarios,
    results,
    startup,
  };
};
