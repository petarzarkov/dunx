import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { run } from './cli.js';

const dirs: string[] = [];

/**
 * Inside the package rather than in `/tmp`, because the fixtures import
 * `@dunx/core` and `@dunx/http` and Bun resolves those by walking up to the
 * workspace root. From `/tmp` there is nothing to walk up to.
 */
const workspace = (): string => {
  const dir = mkdtempSync(join(import.meta.dir, '..', 'cli-fixture-'));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const ENTRY = `import { Module } from '@dunx/core';
import { Controller, Get } from '@dunx/http';

@Controller('users')
class UsersController {
  @Get()
  list() {
    return [];
  }
}

@Module({ controllers: [UsersController] })
class AppModule {}

export default AppModule;
`;

const write = async (
  dir: string,
  name: string,
  body: string,
): Promise<string> => {
  const path = join(dir, name);
  await Bun.write(path, body);
  return path;
};

test('generates a document from a default-exported module', async () => {
  const dir = workspace();
  const entry = await write(dir, 'app.ts', ENTRY);
  const out = join(dir, 'openapi.json');

  expect(await run([entry, '--out', out])).toBe(0);

  const document = await Bun.file(out).json();
  expect(Object.keys(document.paths)).toEqual(['/users']);
  expect(document.openapi).toBe('3.1.0');
});

/*
 * The form that matters for an app mounting Better Auth: the contribution is the
 * app's to describe, because a CLI cannot guess it. Without this the offline
 * document is missing the entire auth surface.
 */
test('honours an `openapi` export, including contribute', async () => {
  const dir = workspace();
  const entry = await write(
    dir,
    'config.ts',
    `${ENTRY}
export const openapi = () => ({
  root: AppModule,
  title: 'Configured',
  version: '9.9.9',
  contribute: [
    {
      paths: { '/auth/sign-in': { post: { responses: {} } } },
      schemas: {},
      tags: [],
    },
  ],
});
`,
  );
  const out = join(dir, 'doc.json');

  expect(await run([entry, '--out', out])).toBe(0);

  const document = await Bun.file(out).json();
  expect(document.info).toEqual({ title: 'Configured', version: '9.9.9' });
  expect(Object.keys(document.paths).sort()).toEqual([
    '/auth/sign-in',
    '/users',
  ]);
});

test('refuses an entry that exports no module, rather than writing an empty one', async () => {
  const dir = workspace();
  const entry = await write(dir, 'nothing.ts', 'export const unrelated = 1;\n');

  expect(await run([entry, '--out', join(dir, 'out.json')])).toBe(1);
  expect(await Bun.file(join(dir, 'out.json')).exists()).toBe(false);
});

test('reports usage when given no entry', async () => {
  expect(await run([])).toBe(1);
});
