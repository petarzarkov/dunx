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

export const selectGenerator = async (
  choice: LoadGeneratorChoice,
): Promise<LoadGenerator> => {
  if (choice === 'fetch') return fetchGenerator();
  const oha = await findOha();
  if (oha !== null) return ohaGenerator(oha.binary, oha.version);
  if (choice === 'oha') {
    throw new Error(
      'oha was requested but not found. Run `bun run setup`, or drop --loadgen.',
    );
  }
  return fetchGenerator();
};
