import { buildDir, root } from './paths.js';
import type { Subject } from './types.js';

/**
 * Node cannot resolve the `.js` specifiers this repo requires (its type stripper
 * does not remap them to `.ts`), and older Node cannot run TypeScript at all. So
 * the Node subjects are transpiled with `Bun.build` first and Node runs the
 * emitted `.mjs`. Dependencies stay external, so Node loads the real express,
 * fastify and hono from node_modules rather than a bundled copy.
 */
export const buildNodeEntries = async (
  list: readonly Subject[],
): Promise<ReadonlyMap<string, string>> => {
  const nodeSubjects = list.filter((subject) => subject.runtime === 'node');
  const emitted = new Map<string, string>();
  if (nodeSubjects.length === 0) return emitted;

  const result = await Bun.build({
    entrypoints: nodeSubjects.map((subject) => `${root}/${subject.entry}`),
    outdir: buildDir,
    target: 'node',
    format: 'esm',
    packages: 'external',
    naming: '[name].mjs',
    minify: false,
    sourcemap: 'none',
  });

  if (!result.success) {
    const reasons = result.logs.map((log) => log.message).join('\n');
    throw new Error(`Failed to transpile Node subjects:\n${reasons}`);
  }

  for (const subject of nodeSubjects) {
    const base =
      subject.entry.split('/').at(-1)?.replace(/\.ts$/, '') ?? subject.id;
    emitted.set(subject.id, `${buildDir}/${base}.mjs`);
  }
  return emitted;
};
