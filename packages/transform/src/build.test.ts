import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPackage } from './build.js';

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const TSCONFIG = {
  compilerOptions: {
    target: 'esnext',
    module: 'preserve',
    moduleResolution: 'bundler',
    strict: true,
    skipLibCheck: true,
  },
  include: ['src'],
};

const SOURCE = `export class Options {
  readonly prefix = 'hi';
}

export class Greeter {
  constructor(private readonly options: Options) {}

  greet(name: string): string {
    return \`\${this.options.prefix} \${name}\`;
  }
}
`;

interface Fixture {
  readonly manifest: Record<string, unknown>;
  readonly files?: Readonly<Record<string, string>>;
}

const scaffold = async (fixture: Fixture): Promise<string> => {
  const root = mkdtempSync(join(tmpdir(), 'dunx-build-'));
  roots.push(root);
  await Bun.write(
    join(root, 'package.json'),
    JSON.stringify(fixture.manifest, null, 2),
  );
  await Bun.write(join(root, 'tsconfig.json'), JSON.stringify(TSCONFIG));
  await mkdir(join(root, 'src'), { recursive: true });
  for (const [rel, body] of Object.entries(fixture.files ?? {})) {
    await Bun.write(join(root, rel), body);
  }
  return root;
};

const library = (extra: Record<string, unknown> = {}): Fixture => ({
  manifest: {
    name: 'acme-thing',
    type: 'module',
    exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' } },
    ...extra,
  },
  files: { 'src/index.ts': SOURCE },
});

describe('buildPackage', () => {
  // The whole reason the subpath is published: a consuming app's plugin skips
  // node_modules, so a package that does not record its dependencies here ships
  // classes the container cannot construct.
  it('records constructor dependencies in the emitted JavaScript', async () => {
    const root = await scaffold(library());
    const built = await buildPackage({ cwd: root, declarations: false });

    expect(built.name).toBe('acme-thing');
    expect(built.entries).toBe(1);
    expect(built.bytes).toBeGreaterThan(0);
    expect(built.entrypoints).toEqual(['src/index.ts']);

    const emitted = await Bun.file(join(root, 'dist/index.js')).text();
    expect(emitted).toContain('Symbol.for("dunx.deps")');
    expect(emitted).toContain('Options');
  });

  it('emits declarations and drops the ones for tests', async () => {
    const fixture = library();
    const root = await scaffold({
      ...fixture,
      files: { ...fixture.files, 'src/index.test.ts': 'export const a = 1;\n' },
    });
    await buildPackage({ cwd: root });

    expect(await Bun.file(join(root, 'dist/index.d.ts')).exists()).toBe(true);
    expect(await Bun.file(join(root, 'dist/index.test.d.ts')).exists()).toBe(
      false,
    );
  });

  it('builds bin entries, makes them executable and drops their types', async () => {
    const fixture = library({ bin: { 'acme-cli': './dist/cli.js' } });
    const root = await scaffold({
      ...fixture,
      files: { ...fixture.files, 'src/cli.ts': "console.log('hi');\n" },
    });
    await buildPackage({ cwd: root });

    const mode = (await stat(join(root, 'dist/cli.js'))).mode;
    expect(mode & 0o111).toBe(0o111);
    expect(await Bun.file(join(root, 'dist/cli.d.ts')).exists()).toBe(false);
    expect(await Bun.file(join(root, 'dist/index.d.ts')).exists()).toBe(true);
  });

  it('takes a string bin as well as a map', async () => {
    const fixture = library({ bin: './dist/cli.js' });
    const root = await scaffold({
      ...fixture,
      files: { ...fixture.files, 'src/cli.ts': "console.log('hi');\n" },
    });
    const built = await buildPackage({ cwd: root, declarations: false });

    expect(built.entrypoints).toContain('src/cli.ts');
  });

  it('refuses a package that is not ESM', async () => {
    const root = await scaffold({
      manifest: { name: 'acme-cjs', exports: { '.': './dist/index.js' } },
      files: { 'src/index.ts': SOURCE },
    });

    await expect(buildPackage({ cwd: root })).rejects.toThrow(
      /"type": "module"/,
    );
  });

  it('refuses an exports target that is not under dist/', async () => {
    const root = await scaffold({
      manifest: {
        name: 'acme-stray',
        type: 'module',
        exports: { '.': './lib/index.js' },
      },
      files: { 'src/index.ts': SOURCE },
    });

    await expect(buildPackage({ cwd: root })).rejects.toThrow(
      /Expected a dist\/ path/,
    );
  });

  it('refuses an exports target with no source behind it', async () => {
    const root = await scaffold({
      manifest: {
        name: 'acme-missing',
        type: 'module',
        exports: { '.': './dist/nope.js' },
      },
      files: { 'src/index.ts': SOURCE },
    });

    await expect(buildPackage({ cwd: root })).rejects.toThrow(
      /no matching source at src\/nope.ts/,
    );
  });

  it('refuses a package with nothing to build', async () => {
    const root = await scaffold({
      manifest: { name: 'acme-empty', type: 'module' },
      files: { 'src/index.ts': SOURCE },
    });

    await expect(buildPackage({ cwd: root })).rejects.toThrow(
      /no "exports" or "bin"/,
    );
  });

  it('reports the failure rather than emitting a broken dist', async () => {
    const fixture = library();
    const root = await scaffold({
      ...fixture,
      files: { 'src/index.ts': "import './missing.js';\n" },
    });

    await expect(
      buildPackage({ cwd: root, declarations: false }),
    ).rejects.toThrow();
  });

  it('surfaces a tsc failure', async () => {
    const root = await scaffold({
      ...library(),
      files: { 'src/index.ts': 'export const broken: number = "no";\n' },
    });

    await expect(buildPackage({ cwd: root })).rejects.toThrow(
      /tsc failed to emit declarations/,
    );
  });
});
