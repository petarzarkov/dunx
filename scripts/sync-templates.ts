/**
 * Copies the feature directories `@dunx/create-app` scaffolds from out of
 * `examples/full`, and the minimal template's source out of `examples/minimal`.
 *
 * The templates are committed rather than generated at publish time so that a
 * source checkout works with no build step and so a diff shows what a consumer will
 * receive. `create-app`'s parity tests fail the moment a copy drifts and name the
 * file to sync, and this is what does the syncing.
 *
 * Run it after changing anything under `examples/full/src/<feature>/` or
 * `examples/minimal/src/`.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { FEATURES } from '../packages/create-app/src/features.js';

const ROOT = new URL('..', import.meta.url).pathname;
const TEMPLATES = join(ROOT, 'packages/create-app/templates');

const copyDir = async (from: string, to: string): Promise<number> => {
  await rm(to, { recursive: true, force: true });
  let count = 0;

  for await (const relative of new Bun.Glob('**/*').scan({
    cwd: from,
    onlyFiles: true,
  })) {
    await Bun.write(join(to, relative), Bun.file(join(from, relative)));
    count += 1;
  }

  return count;
};

let total = 0;

for (const feature of FEATURES) {
  const written = await copyDir(
    join(ROOT, 'examples/full/src', feature.source),
    join(TEMPLATES, 'features', feature.source),
  );
  if (written === 0) {
    throw new Error(
      `Feature "${feature.name}" names examples/full/src/${feature.source}, which has no files.`,
    );
  }
  total += written;
}

// The minimal template is the same arrangement, one example older: its `src` is a
// copy of `examples/minimal/src` and always has been.
const minimal = await copyDir(
  join(ROOT, 'examples/minimal/src'),
  join(TEMPLATES, 'minimal/src'),
);

console.log(
  `synced ${total} files across ${FEATURES.length} features, ` +
    `plus ${minimal} in the minimal template`,
);
