/**
 * Renders the `## Driver cost` section of `README.md` from `results/drivers.json`.
 * Called by `src/readme-tables.ts`; returns `null` when no driver run has been
 * recorded, so a checkout without one still builds.
 */
import { dec, int, signed as signedBy } from './format.js';
import { resultsDir } from './paths.js';
import type { DriversReport } from './types.js';

const signed = (value: number): string => signedBy(value, 1, '%');

const table = (report: DriversReport): string => {
  const base = report.units.find((unit) => unit.id === 'bun:native');
  const rows = report.units.map((unit) => {
    const delta =
      base === undefined || base.rps.median === 0
        ? '-'
        : signed((unit.rps.median / base.rps.median - 1) * 100);
    return (
      `| \`${unit.id}\` | ${unit.runtime} | ${unit.sql} | ${unit.redis} | ` +
      `${int(unit.rps.median)} | ${int(unit.rps.stddev)} | ` +
      `${dec(unit.latencyP50Ms.median, 3)} | ${dec(unit.rssPeakMiB, 1)} | ` +
      `${dec(unit.cpuMsPerKiloRequests, 2)} | ${delta} |`
    );
  });
  return [
    '| Cell | Runtime | Postgres | Redis | req/s | stddev | p50 ms | peak MiB | cpu ms/kreq | vs native |',
    '| ---- | ------- | -------- | ----- | ----: | -----: | -----: | -------: | ----------: | --------: |',
    ...rows,
  ].join('\n');
};

/** One row minus another, as a percentage of the first. */
const gap = (report: DriversReport, from: string, to: string): string => {
  const a = report.units.find((unit) => unit.id === from);
  const b = report.units.find((unit) => unit.id === to);
  if (a === undefined || b === undefined || a.rps.median === 0) return '-';
  return signed((b.rps.median / a.rps.median - 1) * 100);
};

/**
 * Each client swapped **twice**, once against each setting of the other one.
 *
 * A single path through the cells would let either client be quoted from
 * whichever pairing flattered it. Measured, that is not hypothetical: the Redis
 * swap comes out positive against `Bun.SQL` and negative against `pg`, so a table
 * showing only the first row would report a result whose sign the second row
 * disagrees with.
 */
const swapTable = (report: DriversReport): string =>
  [
    '| Swap, same runtime and same server | with the other client native | with the other client classic |',
    '| ---------------------------------- | ---------------------------: | ----------------------------: |',
    `| \`Bun.SQL\` -> \`pg\` | ${gap(report, 'bun:native', 'bun:pg')} | ${gap(report, 'bun:ioredis', 'bun:classic')} |`,
    `| \`Bun.RedisClient\` -> \`ioredis\` | ${gap(report, 'bun:native', 'bun:ioredis')} | ${gap(report, 'bun:pg', 'bun:classic')} |`,
  ].join('\n');

/** The largest run-to-run spread in the set, as a percentage of its own median. */
const worstSpread = (report: DriversReport): string => {
  const spreads = report.units
    .filter((unit) => unit.rps.median > 0)
    .map((unit) => (unit.rps.stddev / unit.rps.median) * 100);
  return spreads.length === 0 ? '-' : `${Math.max(...spreads).toFixed(1)}%`;
};

export const driversSection = async (): Promise<string | null> => {
  const file = Bun.file(`${resultsDir}/drivers.json`);
  if (!(await file.exists())) return null;
  const report = (await file.json()) as DriversReport;
  const { machine: m, config: c, loadGenerator: g } = report;

  return `## Driver cost

What Bun's own database and cache clients are worth against the two a Node service
reaches for. Generated from \`results/drivers.json\` by \`bun src/readme-tables.ts\`.

The \`io\` scenario in the main table cannot answer this. Its Bun subjects run
\`Bun.SQL\` and \`Bun.RedisClient\` and its Node subjects run \`pg\` and \`ioredis\`, so
every gap there is a driver difference **and** a runtime difference. So this harness
runs \`pg\` and \`ioredis\` **on Bun**, next to the native pair on the same runtime, the
same \`Bun.serve\`, the same SQL, the same pool of 8 and the same bytes on the wire.

\`\`\`
${m.cpuModel}, ${m.cores} logical cores, ${m.ramGiB} GiB RAM
${m.platform} ${m.kernel} ${m.arch} | bun ${m.bun} | node ${m.node} | ${g.id} ${g.version}
${c.connections} connections | ${c.warmupSeconds}s warmup | ${c.runs} x ${c.durationSeconds}s measured | ${report.generatedAt.slice(0, 10)}
\`\`\`

${table(report)}

Reproduce with \`bun run drivers\`.

**Read the first four rows and then the fifth, separately.** The first four differ
only in the client, so their differences are the client. \`node:classic\` changes the
runtime and the server as well, and is the reference point rather than a term in the
comparison.

${swapTable(report)}

**The Postgres client is the term that resolves. The Redis client is not.** Swapping
\`Bun.SQL\` for \`pg\` costs in both pairings, by far more than the run-to-run spread,
which tops out here at ${worstSpread(report)}. Swapping \`Bun.RedisClient\` for
\`ioredis\` comes out **positive against \`Bun.SQL\` and negative against \`pg\`**. A
sign change is what an unresolvable difference looks like, so the statement this
supports is that the two Redis clients are the same speed on this workload - not
that either one wins. Both are at their defaults, and those defaults are not the
same: \`Bun.RedisClient\` batches a tick's commands into one write and \`ioredis\`
does not (\`enableAutoPipelining\` is \`false\` in 6.0.0). Tying anyway is the
result; tuning one of them would have been a different measurement.

**The runtime is a larger term than either client.** \`pg\` and \`ioredis\` on Bun
against the same two on Node is ${gap(report, 'bun:classic', 'node:classic')}, where
swapping both clients on one runtime is
${gap(report, 'bun:native', 'bun:classic')}. Quote the first four rows for what the
native clients are worth; most of what a Bun service gains on this workload, it
gains before it picks a client.
`;
};
