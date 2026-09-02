import { binDir } from '../paths.js';
import type { LoadGenerator } from '../types.js';
import { fetchGenerator } from './fetch-driver.js';
import { ohaGenerator } from './oha.js';

export type LoadGeneratorChoice = 'auto' | 'oha' | 'fetch';

const versionOf = async (binary: string): Promise<string | null> => {
  try {
    const proc = Bun.spawn([binary, '--version'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const text = (await new Response(proc.stdout).text()).trim();
    return (await proc.exited) === 0 && text !== '' ? text : null;
  } catch {
    return null;
  }
};

/** `.bin/oha` (what `bun run setup` installs) first, then whatever is on PATH. */
export const findOha = async (): Promise<{
  binary: string;
  version: string;
} | null> => {
  const candidates = [process.env['BENCH_OHA'], `${binDir}/oha`, 'oha'].filter(
    (candidate): candidate is string => candidate !== undefined,
  );
  for (const binary of candidates) {
    const version = await versionOf(binary);
    if (version !== null) return { binary, version };
  }
  return null;
};

/**
 * `allowFallback` exists because the built-in generator cannot resolve what this
 * harness measures, and silently substituting it produced a plausible-looking
 * table nobody could trust.
 *
 * Measured in a checkout with no `.bin/oha`: the fallback capped at 14-65k req/s
 * against oha's 115k on the same row, with standard deviations of 17-30k, and rows
 * in an order that contradicted itself - the `trace` step came out faster than
 * the baseline it is strictly slower than. `bun run logging` decomposes request
 * logging into steps worth 0.04 to 2.04 microseconds; a generator with a 20k
 * standard deviation cannot see any of them.
 *
 * `.bin/oha` is gitignored and installed by `bun run setup`, so a fresh clone or a
 * git worktree never has it. Refusing is the only honest default.
 */
export const selectGenerator = async (
  choice: LoadGeneratorChoice,
  allowFallback = false,
): Promise<LoadGenerator> => {
  // Asking for it by name is consent.
  if (choice === 'fetch') return fetchGenerator();
  const oha = await findOha();
  if (oha !== null) return ohaGenerator(oha.binary, oha.version);
  if (choice === 'oha') {
    throw new Error(
      'oha was requested but not found. Run `bun run setup`, or drop --loadgen.',
    );
  }
  if (!allowFallback) {
    throw new Error(
      'oha was not found, and the built-in generator cannot resolve the ' +
        'differences this harness reports: measured, it has a standard deviation ' +
        'wider than most of the numbers in the table.\n\n' +
        '  bun run setup            install oha, then rerun\n' +
        '  --allow-fallback         accept the built-in generator anyway\n' +
        '  --loadgen fetch          same thing, stated explicitly',
    );
  }
  return fetchGenerator();
};
