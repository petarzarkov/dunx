import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Glob } from 'bun';

const PACKAGE = new URL('..', import.meta.url).pathname;

/**
 * What the published tarball actually carries.
 *
 * This exists because a template file went missing from it for real: npm strips
 * `bunfig.toml`, which is the one file dunx asks an app to have, so every app
 * scaffolded from the published package booted straight into
 * "no dependencies were recorded". Nothing caught it - the templates were on disk,
 * tracked by git, and every test read them from the source tree.
 *
 * So the check is against `bun pm pack` rather than against the directory. Any
 * template name npm decides to rewrite or drop fails here instead of shipping.
 */
const packed = async (): Promise<readonly string[]> => {
  const proc = Bun.spawn(['bun', 'pm', 'pack', '--dry-run'], {
    cwd: PACKAGE,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;

  return out
    .split('\n')
    .map((line) => /packed\s+[\d.]+\s*[KMG]?B\s+(.+)$/.exec(line)?.[1])
    .filter((path): path is string => path !== undefined);
};

const onDisk = async (): Promise<readonly string[]> => {
  const files: string[] = [];
  for await (const file of new Glob('**/*').scan({
    cwd: join(PACKAGE, 'templates'),
    dot: true,
    onlyFiles: true,
  })) {
    files.push(file);
  }
  return files;
};

describe('the published tarball', () => {
  test('carries every template file the scaffolder reads', async () => {
    const shipped = new Set(await packed());
    const missing = (await onDisk()).filter(
      (file) => !shipped.has(`templates/${file}`),
    );

    expect(missing).toEqual([]);
  });

  /**
   * The specific regression. `bunfig.toml` cannot ship under its own name, so a
   * template carrying one has a file the tarball drops - and the generated app
   * loses constructor injection with no warning at pack, publish or install time.
   */
  test('ships no template name that npm strips or rewrites', async () => {
    const files = await onDisk();
    expect(files.length).toBeGreaterThan(50);

    for (const file of files) {
      const base = file.split('/').at(-1) ?? file;
      expect(base).not.toBe('bunfig.toml');
      expect(base).not.toBe('.gitignore');
      expect(base).not.toBe('.npmrc');
    }

    // And the prefixed forms are present, since that is what makes the above safe.
    expect(files).toContain('base/_bunfig.toml');
    expect(files).toContain('minimal/_bunfig.toml');
  });

  test('ships the base and the features, not only the minimal template', async () => {
    const shipped = await packed();
    expect(shipped).toContain('templates/base/tsconfig.json');
    expect(
      shipped.filter((path) => path.startsWith('templates/features/')).length,
    ).toBeGreaterThan(40);
  });
});
