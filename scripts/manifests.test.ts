import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';

/**
 * Things `npm publish` silently "auto-corrects" rather than rejecting. The
 * warning scrolls past in a wall of `npm notice` lines, and the damage lands in
 * the published tarball rather than in the working tree, so nothing here would
 * catch it after the fact.
 *
 * Both cases below were real: `@dunx/create-app` shipped `"./dist/cli.js"` and
 * npm **removed the bin entry entirely**, which would have published a CLI
 * package with no command.
 */
const manifests = async (): Promise<
  { name: string; json: Record<string, unknown> }[]
> => {
  const root = new URL('../packages', import.meta.url).pathname;
  const found: { name: string; json: Record<string, unknown> }[] = [];
  for await (const rel of new Glob('*/package.json').scan({ cwd: root })) {
    const json = (await Bun.file(`${root}/${rel}`).json()) as Record<
      string,
      unknown
    >;
    found.push({ name: String(json['name']), json });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
};

describe('published manifests survive npm publish unaltered', () => {
  it('declares bin paths without a leading ./', async () => {
    for (const { name, json } of await manifests()) {
      const bin = json['bin'];
      if (bin === undefined) continue;
      const paths =
        typeof bin === 'string' ? [bin] : Object.values(bin as object);
      for (const path of paths) {
        // npm treats `./dist/cli.js` as an invalid script name and drops the
        // whole entry, publishing a package whose command does not exist.
        expect(`${name}: ${path}`).not.toMatch(/: \.\//);
      }
    }
  });

  it('stores repository.url in the form npm normalises to', async () => {
    for (const { name, json } of await manifests()) {
      const repo = json['repository'] as { url?: string } | undefined;
      if (repo?.url === undefined) continue;
      expect(`${name}: ${repo.url}`).toMatch(/: git\+https:\/\/.+\.git$/);
    }
  });

  /**
   * The repo is Apache-2.0 and every LICENSE file in it is the Apache text, but
   * all ten manifests said `MIT` - and 0.1.0 went to npm carrying that. A package's
   * declared licence is what tooling and consumers read, so it disagreeing with the
   * file shipped beside it is the one licence bug that actually misleads someone.
   */
  it('declares the licence the LICENSE file actually is', async () => {
    const root = new URL('..', import.meta.url).pathname;
    const licence = await Bun.file(`${root}/LICENSE`).text();
    expect(licence).toContain('Apache License');

    for (const { name, json } of await manifests()) {
      expect(`${name}: ${String(json['license'])}`).toBe(`${name}: Apache-2.0`);
    }
  });

  it('ships an identical LICENSE beside every published package', async () => {
    const root = new URL('..', import.meta.url).pathname;
    const licence = await Bun.file(`${root}/LICENSE`).text();

    for (const { name } of await manifests()) {
      const dir = name.replace('@dunx/', '');
      const shipped = await Bun.file(`${root}/packages/${dir}/LICENSE`).text();
      // `files` lists LICENSE, so a package missing or diverging from it would
      // publish with no licence text at all.
      expect(`${name}: ${shipped === licence}`).toBe(`${name}: true`);
    }
  });

  /**
   * A concrete version here is not a style choice, it is a permanent pin.
   * `version.ts` and `first-publish.ts` only rewrite ranges that still say
   * `workspace:`, so an internal dependency written as `0.1.0` keeps that value
   * through every future release.
   *
   * This happened: an aborted publish left `@dunx/infra` pinned to
   * `@dunx/core@0.1.0` and it was committed, because the earlier version of this
   * test only checked the shape of a workspace range when one was present and
   * said nothing about one going missing.
   */
  it('keeps every internal dependency on workspace:*', async () => {
    for (const { name, json } of await manifests()) {
      for (const field of [
        'dependencies',
        'peerDependencies',
        'optionalDependencies',
      ]) {
        const deps = json[field] as Record<string, string> | undefined;
        if (!deps) continue;
        for (const [dep, range] of Object.entries(deps)) {
          if (!dep.startsWith('@dunx/')) continue;
          expect(`${name}.${field}.${dep}=${range}`).toBe(
            `${name}.${field}.${dep}=workspace:*`,
          );
        }
      }
    }
  });
});
