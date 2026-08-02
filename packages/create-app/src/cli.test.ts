import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The CLI is a top-level-await script that calls `process.exit`, so it can only be
 * exercised by spawning it. Both things tested here are only observable from the
 * outside: the argument parser's tolerance, and what the success message reads
 * like when the target is the directory the user is already in.
 */
const CLI = new URL('./cli.ts', import.meta.url).pathname;

const made: string[] = [];
const workspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dunx-cli-'));
  made.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const run = async (
  cwd: string,
  ...args: string[]
): Promise<{ code: number; stdout: string; stderr: string }> => {
  const proc = Bun.spawn(['bun', CLI, ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

describe('create-app CLI', () => {
  test('accepts --yes as a no-op rather than erroring', async () => {
    const cwd = workspace();
    const { code, stdout, stderr } = await run(cwd, 'app', '--yes');

    expect(stderr).not.toContain('Unknown option');
    expect(code).toBe(0);
    expect(stdout).toContain('bun install');
  });

  test('accepts -y too', async () => {
    const cwd = workspace();
    const { code, stderr } = await run(cwd, 'app', '-y');

    expect(stderr).not.toContain('Unknown option');
    expect(code).toBe(0);
  });

  test('reads correctly when the target is the current directory', async () => {
    const cwd = workspace();
    // `--name` because mkdtemp's suffix may contain uppercase, which npm forbids.
    const { code, stdout } = await run(cwd, '.', '--name', 'in-place');

    expect(code).toBe(0);
    // `in ./` and `cd .` are both nonsense to a reader already standing there.
    expect(stdout).not.toContain('in ./');
    expect(stdout).not.toMatch(/^ *cd \.$/m);
    expect(stdout).toContain('bun install');
  });

  test('still says where it went for a named directory', async () => {
    const cwd = workspace();
    const { code, stdout } = await run(cwd, 'my-api');

    expect(code).toBe(0);
    expect(stdout).toContain('my-api');
    expect(stdout).toContain('cd my-api');
  });

  test('scaffolds in place into a fresh git repo', async () => {
    const cwd = workspace();
    await Bun.write(join(cwd, '.git', 'HEAD'), 'ref: refs/heads/main\n');

    const { code, stderr } = await run(cwd, '.', '--name', 'in-place');

    expect(stderr).not.toContain('is not empty');
    expect(code).toBe(0);
    expect(await Bun.file(join(cwd, 'src', 'main.ts')).exists()).toBe(true);
  });

  test('lists --yes in the usage text', async () => {
    const { code, stdout } = await run(workspace(), '--help');

    expect(code).toBe(0);
    expect(stdout).toContain('--yes');
  });
});
