import type { SubjectProcess } from './subject-process.js';
import type { LoadGenerator, LoadRequest, LoadSample } from './types.js';

/** Progress goes to stderr, so stdout stays the report a caller may redirect. */
export const note = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

export const num = (raw: string | undefined, fallback: number): number =>
  raw === undefined ? fallback : Number(raw);

/** One subject under measurement: what it is, where it runs, what it answered. */
export interface Live<U> {
  readonly unit: U;
  readonly server: SubjectProcess;
  readonly request: LoadRequest;
  readonly samples: LoadSample[];
}

/** The subset of `BenchConfig` a side harness reads. */
export interface DriverConfig {
  readonly connections: number;
  readonly durationSeconds: number;
  readonly warmupSeconds: number;
  readonly runs: number;
}

/**
 * Bring every unit up, warm each one, then sample them round-robin, stopping
 * every server that started whether or not the run finished.
 *
 * Round-robin rather than one subject at a time: a machine that drifts warmer or
 * busier over the run then moves every subject together instead of penalising
 * whichever went last. `db-modes`, `logging` and `validation` each had a copy of
 * this loop, which is three places for the measurement to drift apart.
 */
export const driveUnits = async <U extends { readonly id: string }>(
  units: readonly U[],
  bring: (unit: U) => Promise<Live<U>>,
  generator: LoadGenerator,
  config: DriverConfig,
): Promise<readonly Live<U>[]> => {
  const live: Live<U>[] = [];
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
    // By distinct server, not by entry: `db-modes` runs several units against one
    // process per mode, so stopping per entry would stop the same one repeatedly.
    for (const server of new Set(live.map((entry) => entry.server))) {
      await server.stop();
    }
  }
  return live;
};
