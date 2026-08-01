import { dirname, resolve } from 'node:path';

/** `tools/bench` — every other path in the harness is derived from it. */
export const root = resolve(dirname(Bun.fileURLToPath(import.meta.url)), '..');

export const repoRoot = resolve(root, '../..');

/** Transpiled Node subject entrypoints. Gitignored, rebuilt on every run. */
export const buildDir = `${root}/.bench-tmp`;

export const resultsDir = `${root}/results`;

export const binDir = `${root}/.bin`;
