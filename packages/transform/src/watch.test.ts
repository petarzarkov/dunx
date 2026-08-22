import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The plugin has to read source **through Bun's loader**, or every file it handles
 * drops out of Bun's watch list and `bun --watch` restarts only on a change to the
 * entrypoint. That regressed silently once - the app boots, the transform works,
 * every other test passes, and only a developer editing a file notices.
 *
 * So this spawns a real watch and edits a real imported file. There is no unit-level
 * proxy for it: the property belongs to Bun's module graph, not to any return value.
 */
const PRELOAD = join(import.meta.dir, 'preload.ts');

let directory: string | undefined;
let child: Bun.Subprocess | undefined;

afterEach(async () => {
  child?.kill(9);
  child = undefined;
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/** Polls rather than sleeps a fixed budget, so a fast machine is not waited on. */
const until = async (
  predicate: () => Promise<boolean> | boolean,
  budgetMs = 20_000,
): Promise<boolean> => {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await Bun.sleep(100);
  }
  return false;
};

test('bun --watch restarts when a transformed import changes', async () => {
  directory = await mkdtemp(join(tmpdir(), 'dunx-watch-'));
  const log = join(directory, 'out.log');
  const dep = join(directory, 'dep.ts');
  const entry = join(directory, 'entry.ts');

  // `dep.ts` declares a class, so it takes the transform's parsing path rather
  // than the class-free shortcut - the case that matters.
  await Bun.write(dep, 'export class Dep {\n  value = 1;\n}\n');
  await Bun.write(
    entry,
    "import { Dep } from './dep.js';\nconsole.log('BOOTED', new Dep().value);\n" +
      'setInterval(() => undefined, 1000);\n',
  );
  await Bun.write(log, '');

  const boots = async (): Promise<number> =>
    (await Bun.file(log).text()).split('BOOTED').length - 1;

  child = Bun.spawn(['bun', '--preload', PRELOAD, '--watch', entry], {
    cwd: directory,
    stdout: Bun.file(log),
    stderr: Bun.file(log),
  });

  expect(await until(async () => (await boots()) >= 1)).toBe(true);

  await appendFile(dep, '\n// edited\n');

  expect(await until(async () => (await boots()) >= 2)).toBe(true);
  // A generous own timeout, so a slow machine reports the assertion rather than a
  // cutoff: the passing path takes about 0.2 s, and the failing one waits out the
  // budget above.
}, 40_000);
