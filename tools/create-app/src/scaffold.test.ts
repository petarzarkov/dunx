import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Glob } from 'bun';
import { scaffold, ScaffoldError, VERSION_PLACEHOLDER } from './scaffold.js';

const made: string[] = [];
const workspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dunx-create-'));
  made.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const read = (dir: string, file: string): Promise<string> =>
  Bun.file(join(dir, file)).text();

describe('scaffold', () => {
  test('writes a runnable app and names it after the directory', async () => {
    const cwd = workspace();
    const result = await scaffold({ target: 'my-api', cwd });

    expect(result.name).toBe('my-api');
    expect(result.template).toBe('minimal');
    expect(result.files).toContain('src/main.ts');
    expect(result.files).toContain('bunfig.toml');

    const manifest = JSON.parse(
      await read(result.directory, 'package.json'),
    ) as { name: string; dependencies: Record<string, string> };
    expect(manifest.name).toBe('my-api');
  });

  test('resolves the version placeholder - lockstep makes it knowable', async () => {
    const cwd = workspace();
    const { directory } = await scaffold({ target: 'app', cwd });
    const manifest = await read(directory, 'package.json');

    expect(manifest).not.toContain(VERSION_PLACEHOLDER);
    const parsed = JSON.parse(manifest) as {
      dependencies: Record<string, string>;
    };
    // Every @dunx dependency must be a real range, not a workspace protocol -
    // `workspace:*` in a scaffolded app is an install error.
    for (const [name, range] of Object.entries(parsed.dependencies)) {
      expect(name.startsWith('@dunx/')).toBe(true);
      expect(range.startsWith('workspace:')).toBe(false);
      expect(range).toMatch(/^\^?\d+\.\d+\.\d+/);
    }
  });

  test('ships .gitignore under a name npm will not rename', async () => {
    const cwd = workspace();
    const { directory, files } = await scaffold({ target: 'app', cwd });

    // npm renames a published `.gitignore` to `.npmignore`, so the template
    // carries `_gitignore` and the scaffolder puts the dot back.
    expect(files).toContain('.gitignore');
    expect(files).not.toContain('_gitignore');
    expect(await read(directory, '.gitignore')).toContain('node_modules');
  });

  test('leaves no placeholder anywhere in the output', async () => {
    const cwd = workspace();
    const { directory } = await scaffold({ target: 'app', cwd });

    for await (const file of new Glob('**/*').scan({
      cwd: directory,
      dot: true,
      onlyFiles: true,
    })) {
      const text = await read(directory, file);
      expect(text).not.toContain(VERSION_PLACEHOLDER);
      expect(text).not.toContain('__DUNX_APP_NAME__');
    }
  });

  test('writes agent instructions for the fixed template too', async () => {
    const cwd = workspace();
    const { directory, files } = await scaffold({ target: 'my-api', cwd });

    expect(files).toContain('AGENTS.md');
    expect(files).toContain('CLAUDE.md');

    const agents = await read(directory, 'AGENTS.md');
    expect(agents).toContain('# my-api');
    // The rules an agent breaks first, and where the framework's own instructions
    // live rather than a copy of them frozen at scaffold time.
    expect(agents).toContain('@Injectable()');
    expect(agents).toContain('https://petarzarkov.github.io/dunx/setup.md');
    expect(agents).toContain('bunx @dunx/mcp');

    // A pointer, so Claude Code and everything else read one file.
    const claude = await read(directory, 'CLAUDE.md');
    expect(claude).toContain('@AGENTS.md');
    expect(claude.length).toBeLessThan(agents.length);
  });

  test('refuses a non-empty directory unless forced', async () => {
    const cwd = workspace();
    await Bun.write(join(cwd, 'taken', 'keep.txt'), 'mine');

    await expect(scaffold({ target: 'taken', cwd })).rejects.toThrow(
      ScaffoldError,
    );

    const { files } = await scaffold({ target: 'taken', cwd, force: true });
    expect(files).toContain('src/main.ts');
    // Forcing writes alongside; it does not clear the directory.
    expect(await read(cwd, 'taken/keep.txt')).toBe('mine');
  });

  test('scaffolds into a directory holding nothing but .git', async () => {
    const cwd = workspace();
    // What `git init` leaves behind. `git init && bunx @dunx/create-app .` is the
    // documented way to start, so this must not be refused.
    await Bun.write(
      join(cwd, 'repo', '.git', 'HEAD'),
      'ref: refs/heads/main\n',
    );

    const { files } = await scaffold({ target: 'repo', cwd });
    expect(files).toContain('src/main.ts');
    // The repo it scaffolded into is still a repo.
    expect(await read(cwd, 'repo/.git/HEAD')).toBe('ref: refs/heads/main\n');
  });

  test.each(['.gitkeep', '.DS_Store', 'LICENSE'])(
    'scaffolds into a directory holding nothing but %s',
    async (entry) => {
      const cwd = workspace();
      await Bun.write(join(cwd, 'repo', entry), 'x');

      const { files } = await scaffold({ target: 'repo', cwd });
      expect(files).toContain('src/main.ts');
    },
  );

  test('still refuses when a real file sits beside the ignored ones', async () => {
    const cwd = workspace();
    await Bun.write(
      join(cwd, 'repo', '.git', 'HEAD'),
      'ref: refs/heads/main\n',
    );
    await Bun.write(join(cwd, 'repo', 'src', 'existing.ts'), 'export {};');

    await expect(scaffold({ target: 'repo', cwd })).rejects.toThrow(
      ScaffoldError,
    );
  });

  // `.gitignore` and `README.md` both come out of the template, so ignoring them
  // would overwrite the user's copy without the --force that gates it.
  test.each(['.gitignore', 'README.md'])(
    'does not ignore %s, which the template writes',
    async (entry) => {
      const cwd = workspace();
      await Bun.write(join(cwd, 'repo', entry), 'mine');

      await expect(scaffold({ target: 'repo', cwd })).rejects.toThrow(
        ScaffoldError,
      );
    },
  );

  test('rejects a name npm would reject, before creating anything', async () => {
    const cwd = workspace();
    await expect(
      scaffold({ target: 'ok', name: 'Not Valid', cwd }),
    ).rejects.toThrow(ScaffoldError);
  });

  test('rejects an unknown template', async () => {
    const cwd = workspace();
    await expect(
      scaffold({ target: 'app', cwd, template: 'nope' as never }),
    ).rejects.toThrow(/Unknown template/);
  });
});

/**
 * The template's source is a copy of `examples/minimal/src`, which is the example
 * CI actually boots. A copy drifts silently, so this fails the moment they differ
 * and names the file to sync.
 */
describe('the minimal template', () => {
  test('matches examples/minimal source byte for byte', async () => {
    const here = new URL('..', import.meta.url).pathname;
    const templateSrc = join(here, 'templates/minimal/src');
    const exampleSrc = join(here, '../../examples/minimal/src');

    const names: string[] = [];
    for await (const file of new Glob('*.ts').scan({ cwd: templateSrc })) {
      names.push(file);
    }
    expect(names.length).toBeGreaterThan(0);

    for (const file of names) {
      expect(await Bun.file(join(templateSrc, file)).text()).toBe(
        await Bun.file(join(exampleSrc, file)).text(),
      );
    }
  });
});
