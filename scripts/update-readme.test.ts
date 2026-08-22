import { describe, expect, it } from 'bun:test';

const REPO = new URL('..', import.meta.url).pathname;

const run = async (
  args: readonly string[] = [],
): Promise<{ code: number; out: string }> => {
  const proc = Bun.spawn(['bun', 'scripts/update-readme.ts', ...args], {
    cwd: REPO,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, out: out + err };
};

/**
 * These exist because `gen:readme` was broken for an unknown length of time and
 * nothing said so.
 *
 * It compared the rewritten file against the original and aborted when they were
 * equal, which conflated "no such heading" with "already correct" - so it succeeded
 * once after a real change and failed on every run afterwards, reporting a missing
 * section that was right there. No test ran it and CI never called it, so the only
 * signal was somebody trying to use it.
 *
 * Spawned rather than imported: the script is a program with top-level effects and
 * a `process.exit`, and its exit code is the half that was wrong.
 */
describe('gen:readme', () => {
  it('succeeds and rewrites nothing when both blocks are current', async () => {
    // Ordering matters: this leaves the tree current for the checks below.
    const first = await run();
    expect(first.code).toBe(0);

    const second = await run();
    expect(second.code).toBe(0);
    expect(second.out).toContain('Already current');
  });

  it('is idempotent, which is what the old guard made impossible', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await run()).code).toBe(0);
    }
  });

  it('passes --check when the committed blocks match the manifests', async () => {
    const result = await run(['--check']);
    expect(result.code).toBe(0);
    expect(result.out).toContain('current');
  });

  /**
   * `--check` has to fail on drift and write nothing, because that is what makes it
   * usable in CI - the whole reason the original breakage went unnoticed.
   */
  it('fails --check on a stale block, and leaves the file alone', async () => {
    const path = `${REPO}README.md`;
    const original = await Bun.file(path).text();
    const marker = '| Package | Npm | Coverage | Description |';
    expect(original).toContain(marker);

    await Bun.write(
      path,
      original.replace(marker, '| Package | Npm | Coverage | STALE |'),
    );
    try {
      const result = await run(['--check']);
      expect(result.code).toBe(1);
      expect(result.out).toContain('stale');
      // Unchanged: --check reports, it does not repair.
      expect(await Bun.file(path).text()).toContain('STALE');
    } finally {
      await Bun.write(path, original);
    }
    expect(await Bun.file(path).text()).toBe(original);
  });

  it('regenerates a stale block and reports which file it touched', async () => {
    const path = `${REPO}README.md`;
    const original = await Bun.file(path).text();
    await Bun.write(
      path,
      original.replace(
        '| Package | Npm | Coverage | Description |',
        '| Package | Npm | Coverage | STALE |',
      ),
    );
    try {
      const result = await run();
      expect(result.code).toBe(0);
      expect(result.out).toContain('README.md');
      expect(await Bun.file(path).text()).toBe(original);
    } finally {
      await Bun.write(path, original);
    }
  });

  /**
   * A missing heading is a real failure and still has to abort - the fix must not
   * have turned the abort into a silent pass.
   */
  it('still aborts when a section heading is genuinely absent', async () => {
    const path = `${REPO}CONTRIBUTING.md`;
    const original = await Bun.file(path).text();
    await Bun.write(
      path,
      original.replace('## Project Structure', '## Renamed Structure'),
    );
    try {
      const result = await run();
      expect(result.code).toBe(1);
      expect(result.out).toContain('No "## Project Structure" section found');
    } finally {
      await Bun.write(path, original);
    }
  });

  /**
   * The old script wrote README.md and *then* aborted on CONTRIBUTING.md, leaving
   * the repo half-regenerated. Both files are resolved before either is written.
   */
  it('writes nothing at all when the other file is unusable', async () => {
    const readmePath = `${REPO}README.md`;
    const contributingPath = `${REPO}CONTRIBUTING.md`;
    const readme = await Bun.file(readmePath).text();
    const contributing = await Bun.file(contributingPath).text();

    await Bun.write(
      readmePath,
      readme.replace(
        '| Package | Npm | Coverage | Description |',
        '| Package | Npm | Coverage | STALE |',
      ),
    );
    await Bun.write(
      contributingPath,
      contributing.replace('## Project Structure', '## Renamed Structure'),
    );
    try {
      expect((await run()).code).toBe(1);
      // README was stale and rewritable, and still was not touched.
      expect(await Bun.file(readmePath).text()).toContain('STALE');
    } finally {
      await Bun.write(readmePath, readme);
      await Bun.write(contributingPath, contributing);
    }
  });
});
