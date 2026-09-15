// Imported from source, not dist: this script is what builds @dunx/transform, so
// depending on its output would not bootstrap.
import { buildPackage } from '../packages/transform/src/build.js';

/**
 * Bun-native package build. Run from a package root: `bun ../../scripts/build-package.ts`.
 *
 * The build itself is `@dunx/transform/build`, which is published for exactly
 * this: a package whose classes the container constructs has to record its
 * constructor dependencies at build time. Every workspace here goes through the
 * same entrypoint an outside author calls, so the two cannot drift.
 */
const built = await buildPackage();

console.log(
  `${built.name}: ${built.entries} entr${built.entries === 1 ? 'y' : 'ies'} + ` +
    `declarations, ${(built.bytes / 1024).toFixed(1)} KiB, ${built.ms}ms -> dist/`,
);
