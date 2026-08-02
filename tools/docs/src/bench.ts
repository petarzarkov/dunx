import type {
  BenchModel,
  BenchRuntime,
  BenchSubject,
} from '../scripts/extract/model';

/** The ceiling every throughput number is expressed against. */
export const BASELINE = 'bun-serve';

/** The subject this site is about. Marked in every table, wins and losses alike. */
export const FOCUS = 'dunx';

/** The same app with `requestLogging` left on, measured separately on purpose. */
export const FOCUS_LOGGING = 'dunx-logging';

/**
 * Run-to-run spread on this setup, in percentage points of the baseline. A gap
 * narrower than this is not a result, and a headline that reads it as one is
 * the page lying quietly. The benchmark page states the same figure.
 */
export const NOISE_PCT = 3;

export const Verdict = Object.freeze({
  Ahead: 'ahead',
  Tied: 'tied',
  Behind: 'behind',
} as const);
export type Verdict = (typeof Verdict)[keyof typeof Verdict];

export const verdictOf = (focusPct: number, rivalPct: number): Verdict => {
  const gap = focusPct - rivalPct;
  if (Math.abs(gap) <= NOISE_PCT) return Verdict.Tied;
  return gap > 0 ? Verdict.Ahead : Verdict.Behind;
};

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
  const baseline = cells.find((cell) => cell.subject === BASELINE)?.rps;

  return cells
    .flatMap((cell) => {
      const subject = subjects.get(cell.subject);
      if (!subject) return [];
      const reference = baseline ?? cell.rps;

      return [
        {
          id: subject.id,
          label: subject.label,
          runtime: subject.runtime,
          version: subject.version,
          rps: cell.rps,
          stddev: cell.rpsStddev,
          p50: cell.p50Ms,
          p99: cell.p99Ms,
          pctOfBaseline: reference === 0 ? 0 : (cell.rps / reference) * 100,
          bad: cell.bad,
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
          minMs: entry.minMs,
          maxMs: entry.maxMs,
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
  /** Fastest subject that is not the raw baseline - the framework dunx is up against. */
  readonly rivalLabel: string;
  readonly rivalPct: number;
  /** Strict ordering. `Where dunx loses` is driven by this and not by the verdict. */
  readonly focusLeadsRival: boolean;
  /** The same comparison read against `NOISE_PCT`. */
  readonly verdict: Verdict;
  /** Percentage of the baseline the same app reaches with request logging on. */
  readonly loggingPct: number | null;
}

export const scenarioHeadlines = (model: BenchModel): ScenarioHeadline[] =>
  model.scenarios.flatMap((scenario) => {
    const rows = throughputRows(model, scenario.id);
    const focusIndex = rows.findIndex((row) => row.id === FOCUS);
    const focus = rows[focusIndex];
    const rival = rows.find(
      (row) =>
        row.id !== BASELINE && row.id !== FOCUS && row.id !== FOCUS_LOGGING,
    );
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
        verdict: verdictOf(focus.pctOfBaseline, rival.pctOfBaseline),
        loggingPct:
          rows.find((row) => row.id === FOCUS_LOGGING)?.pctOfBaseline ?? null,
      },
    ];
  });

export interface Scoreboard {
  readonly ahead: number;
  readonly tied: number;
  readonly behind: number;
  readonly total: number;
  /** The rival every scenario was read against, when it is the same one. */
  readonly rivalLabel: string | null;
}

/**
 * How dunx did against the fastest other framework, scenario by scenario, with
 * the noise band applied. Computed rather than written down: a rerun that turns
 * a win into a tie has to change this sentence too.
 */
export const scoreboard = (model: BenchModel): Scoreboard => {
  const headlines = scenarioHeadlines(model);
  const rivals = new Set(headlines.map((headline) => headline.rivalLabel));
  const count = (verdict: Verdict): number =>
    headlines.filter((headline) => headline.verdict === verdict).length;

  return {
    ahead: count(Verdict.Ahead),
    tied: count(Verdict.Tied),
    behind: count(Verdict.Behind),
    total: headlines.length,
    rivalLabel: rivals.size === 1 ? ([...rivals][0] ?? null) : null,
  };
};

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
