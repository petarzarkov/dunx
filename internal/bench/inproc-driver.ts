/**
 * Spawns `inproc.ts` once per variant per round, round-robin, so machine drift
 * lands on round rather than on row identity - the reason `src/logging.ts`
 * interleaves its units too.
 */
const LADDER = [
  'floor',
  'chain',
  'url',
  'ignored',
  'clock',
  'inbound',
  'mint',
  'scope',
  'als',
  'request',
  'then',
  'respheader',
  'entry-discard',
  'entry-stamp',
  'entry-rest',
  'entry-assemble',
  'entry-short',
  'entry-lean',
  'entry-serialize',
  'entry-write',
  'precomp',
  'precomp-noua',
  'precomp-nowrite',
  'precomp-const',
  'precomp-max',
  'bound',
];
const FORMATS = [
  'floor',
  'default',
  'merge',
  'lean',
  'text',
  'nomerge',
  'fastjson',
  'aot',
  'direct',
  'aotdirect',
];
const PICK = process.env['ONLY'];
const VARIANTS =
  PICK !== undefined
    ? PICK.split(',')
    : process.env['MODE'] === 'ladder'
      ? LADDER
      : FORMATS;
const ROUNDS = Number(process.argv[2] ?? 7);
const ARGS = process.argv.slice(3);

const once = async (variant: string): Promise<number> => {
  const proc = Bun.spawn(['bun', ...ARGS, 'inproc.ts', variant], {
    stdout: 'ignore',
    stderr: 'pipe',
    cwd: import.meta.dir,
  });
  const text = await new Response(proc.stderr).text();
  if ((await proc.exited) !== 0) throw new Error(`${variant} failed: ${text}`);
  const value = Number(text.trim().split('\n').at(-1));
  if (!Number.isFinite(value)) throw new Error(`${variant}: ${text}`);
  return value;
};

const samples = new Map<string, number[]>(VARIANTS.map((v) => [v, []]));
for (let round = 0; round < ROUNDS; round += 1) {
  // Rotated by round. Running the list in the same order every time maps a
  // within-round trend, a thermal ramp or a scheduler that settles after the
  // first spawn, onto position in the list, which is the drift this was supposed
  // to spread. Rotating gives every variant every position.
  for (let i = 0; i < VARIANTS.length; i += 1) {
    const variant = VARIANTS[(i + round) % VARIANTS.length]!;
    samples.get(variant)!.push(await once(variant));
  }
  process.stderr.write(`round ${round + 1} of ${ROUNDS}\n`);
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

const stats = VARIANTS.map((variant) => {
  const values = samples.get(variant)!;
  const mid = median(values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = Math.sqrt(
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length,
  );
  return { variant, median: mid, sd };
});

console.log('\nvariant       ns/req      sd   this step   vs floor');
let previous: number | undefined;
// Absent when the selection did not include it, and then there is no baseline to
// subtract: printing the raw median under a "vs floor" heading reads as a cost
// over nothing.
const floor = stats.find((s) => s.variant === 'floor')?.median;
for (const s of stats) {
  const step = previous === undefined ? 0 : s.median - previous;
  console.log(
    `${s.variant.padEnd(12)} ${s.median.toFixed(0).padStart(6)}  ${s.sd.toFixed(0).padStart(6)}  ` +
      `${(previous === undefined ? '-' : (step >= 0 ? '+' : '') + step.toFixed(0)).padStart(9)}  ` +
      `${(floor === undefined ? '-' : (s.median - floor).toFixed(0)).padStart(9)}`,
  );
  previous = s.median;
}
