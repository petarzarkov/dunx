import { readFileSync } from 'node:fs';

/**
 * This package's own version, read from its own manifest at run time.
 *
 * Not imported from `package.json`: `Bun.build` would inline the value, and the
 * release job builds **before** `scripts/version.ts` bumps the manifests, so an
 * inlined version is the previous release's. A read resolves against
 * `dist/../package.json` in the published package and `src/../package.json` in a
 * checkout, and the tarball npm publishes carries the bumped manifest.
 *
 * Synchronous, and a function rather than a class, because it is one file read
 * with nothing to configure. Memoized: `dunx_scaffold` can be called repeatedly
 * in one session and the answer cannot change while the process lives.
 */
let cached: string | undefined;

export const ownVersion = (): string => {
  if (cached !== undefined) return cached;
  try {
    const manifest = readFileSync(`${import.meta.dir}/../package.json`, 'utf8');
    cached = (JSON.parse(manifest) as { version?: string }).version ?? '0.0.0';
  } catch {
    // A layout with no manifest beside the code. Nothing here is worth failing a
    // whole server over, and `0.0.0` reads as "unknown" rather than as a version
    // somebody might install.
    cached = '0.0.0';
  }
  return cached;
};
