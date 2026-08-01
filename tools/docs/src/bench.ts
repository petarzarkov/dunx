import type {
  BenchModel,
  BenchRuntime,
  BenchSubject,
} from '../scripts/extract/model';

/** The ceiling every throughput number is expressed against. */
export const BASELINE = 'bun-serve';

/** The subject this site is about. Marked in every table, wins and losses alike. */
export const FOCUS = 'dunx';

export interface ThroughputRow {
  readonly id: string;
  readonly label: string;
  readonly runtime: BenchRuntime;
  readonly version: string;
  readonly rps: number;
  readonly stddev: number;
  readonly p50: number;
  readonly p99: number;
  /** Percentage of the raw `Bun.serve` baseline on this scenario. */
  readonly pctOfBaseline: number;
  /** Non-2xx responses plus transport errors. Anything but 0 invalidates the row. */
  readonly bad: number;
}

export interface StartupRow {
  readonly id: string;
  readonly label: string;
  readonly runtime: BenchRuntime;
  readonly medianMs: number;
  readonly minMs: number;
  readonly maxMs: number;
  /** Multiple of the raw `Bun.serve` baseline. Above 1 is slower. */
  readonly ratioToBaseline: number;
}

const subjectsById = (model: BenchModel): Map<string, BenchSubject> =>
  new Map(model.subjects.map((subject) => [subject.id, subject]));

/**
 * Every subject's numbers for one scenario, ordered by measured throughput and
 * nothing else. The ordering is the result; it is not adjusted for anybody.
 */
export const throughputRows = (
  model: BenchModel,
  scenarioId: string,
): ThroughputRow[] => {
  const subjects = subjectsById(model);
  const cells = model.results.filter(
    (result) => result.scenario === scenarioId,
  );
  const baseline = cells.find((cell) => cell.subject === BASELINE)?.rps.median;

  return cells
    .flatMap((cell) => {
      const subject = subjects.get(cell.subject);
      if (!subject) return [];
      const reference = baseline ?? cell.rps.median;

      return [
        {
          id: subject.id,
          label: subject.label,
          runtime: subject.runtime,
          version: subject.version,
          rps: cell.rps.median,
          stddev: cell.rps.stddev,
          p50: cell.latencyP50Ms.median,
          p99: cell.latencyP99Ms.median,
          pctOfBaseline:
            reference === 0 ? 0 : (cell.rps.median / reference) * 100,
          bad: cell.totalErrors + cell.totalNon2xx,
        },
      ];
    })
    .sort((a, b) => b.rps - a.rps);
};

export const startupRows = (model: BenchModel): StartupRow[] => {
  const subjects = subjectsById(model);
  const baseline = model.startup.find(
    (entry) => entry.subject === BASELINE,
  )?.medianMs;

  return model.startup
    .flatMap((entry) => {
      const subject = subjects.get(entry.subject);
      if (!subject) return [];
      const reference = baseline ?? entry.medianMs;

      return [
        {
          id: subject.id,
          label: subject.label,
          runtime: subject.runtime,
          medianMs: entry.medianMs,
          minMs: Math.min(...entry.samplesMs),
          maxMs: Math.max(...entry.samplesMs),
          ratioToBaseline: reference === 0 ? 0 : entry.medianMs / reference,
        },
      ];
    })
    .sort((a, b) => a.medianMs - b.medianMs);
};

export interface ScenarioHeadline {
  readonly id: string;
  readonly title: string;
  readonly focusRps: number;
  readonly focusPct: number;
  readonly focusRank: number;
  readonly subjectCount: number;
  /** Fastest subject that is not the raw baseline — the framework dunx is up against. */
  readonly rivalLabel: string;
  readonly rivalPct: number;
  readonly focusLeadsRival: boolean;
}

export const scenarioHeadlines = (model: BenchModel): ScenarioHeadline[] =>
  model.scenarios.flatMap((scenario) => {
    const rows = throughputRows(model, scenario.id);
    const focusIndex = rows.findIndex((row) => row.id === FOCUS);
    const focus = rows[focusIndex];
    const rival = rows.find((row) => row.id !== BASELINE && row.id !== FOCUS);
    if (!focus || !rival) return [];

    return [
      {
        id: scenario.id,
        title: scenario.title,
        focusRps: focus.rps,
        focusPct: focus.pctOfBaseline,
        focusRank: focusIndex + 1,
        subjectCount: rows.length,
        rivalLabel: rival.label,
        rivalPct: rival.pctOfBaseline,
        focusLeadsRival: focus.rps >= rival.rps,
      },
    ];
  });

export interface StartupHeadline {
  readonly focusMs: number;
  readonly baselineMs: number;
  readonly baselineLabel: string;
  readonly ratio: number;
  readonly rank: number;
  readonly total: number;
}

export const startupHeadline = (model: BenchModel): StartupHeadline | null => {
  const rows = startupRows(model);
  const index = rows.findIndex((row) => row.id === FOCUS);
  const focus = rows[index];
  const baseline = rows.find((row) => row.id === BASELINE);
  if (!focus || !baseline) return null;

  return {
    focusMs: focus.medianMs,
    baselineMs: baseline.medianMs,
    baselineLabel: baseline.label,
    ratio: focus.ratioToBaseline,
    rank: index + 1,
    total: rows.length,
  };
};

export const machineLine = (model: BenchModel): string => {
  const { machine } = model;
  return (
    `${machine.cpuModel}, ${machine.cores} logical cores, ${machine.ramGiB} GiB RAM · ` +
    `${machine.platform} ${machine.kernel} ${machine.arch} · ` +
    `bun ${machine.bun} · node ${machine.node}`
  );
};

export const configLine = (model: BenchModel): string => {
  const { config, loadGenerator } = model;
  return (
    `${config.connections} connections · ${config.warmupSeconds}s warmup · ` +
    `${config.runs} x ${config.durationSeconds}s measured (median) · ` +
    `${config.startupSamples} startup samples · ${loadGenerator.version}`
  );
};

export const integer = (value: number): string =>
  Math.round(value).toLocaleString('en-US');

export const decimal = (value: number, places = 2): string =>
  value.toFixed(places);
