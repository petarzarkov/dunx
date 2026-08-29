import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FEATURES } from './features.js';
import { CancelledError, PromptRunner } from './prompt.js';
import { Style } from './style.js';
import { MemoryTty, Press } from './tty.fixture.js';
import { slug, Wizard, type WizardAnswers } from './wizard.js';

const style = new Style(false);

const type = (text: string): readonly string[] => Array.from(text);

const made: string[] = [];
const workspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dunx-wizard-'));
  made.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/**
 * One turn of the loop, which is what a question costs: the wizard reaches the
 * next `ask` through at least one await, so keys sent before that land nowhere.
 */
const settle = (): Promise<void> => Bun.sleep(0);

interface Session {
  readonly tty: MemoryTty;
  readonly answers: Promise<WizardAnswers>;
}

const start = async (
  cwd: string,
  defaults: Partial<Parameters<Wizard['run']>[0]> = {},
): Promise<Session> => {
  const tty = new MemoryTty();
  const wizard = new Wizard(new PromptRunner(tty), style);
  const answers = wizard.run({
    target: 'my-api',
    name: undefined,
    features: [],
    force: false,
    cwd,
    ...defaults,
  });
  // Swallowed here and asserted on below: a rejection reaching the loop before
  // the test awaits it is an unhandled rejection, which fails the whole file.
  answers.catch(() => undefined);
  await settle();
  return { tty, answers };
};

describe('Wizard', () => {
  test('asks only the feature question when the flags settled the rest', async () => {
    const { tty, answers } = await start(workspace());

    tty.send('a', Press.enter);

    expect((await answers).features).toHaveLength(FEATURES.length);
    expect(tty.opened).toBe(1);
  });

  test('asks for a directory when none was given', async () => {
    const cwd = workspace();
    const { tty, answers } = await start(cwd, { target: undefined });

    expect(tty.output()).toContain('Directory');
    tty.send(Press.clearLine, ...type('billing'), Press.enter);
    await settle();
    tty.send(Press.enter);

    const result = await answers;
    expect(result.target).toBe('billing');
    expect(result.name).toBe('billing');
  });

  test('asks for a package name only when the directory is not one', async () => {
    const cwd = workspace();
    const { tty, answers } = await start(cwd, { target: 'My-API' });

    // The suggestion is the directory name npm would have rejected, fixed.
    expect(tty.output()).toContain('Package name');
    tty.send(Press.enter);
    await settle();
    tty.send(Press.enter);

    const result = await answers;
    expect(result.target).toBe('My-API');
    expect(result.name).toBe('my-api');
  });

  test('refuses a package name npm would refuse, and says why', async () => {
    const cwd = workspace();
    const { tty, answers } = await start(cwd, { target: 'My-API' });

    tty.send(Press.clearLine, ...type('Nope'), Press.enter);
    expect(tty.output()).toContain('npm forbids uppercase');

    tty.send(Press.clearLine, ...type('nope'), Press.enter);
    await settle();
    tty.send(Press.enter);

    expect((await answers).name).toBe('nope');
  });

  test('asks before writing into a directory that already has files', async () => {
    const cwd = workspace();
    await Bun.write(join(cwd, 'app', 'notes.ts'), 'export {};');
    const { tty, answers } = await start(cwd, { target: 'app' });

    tty.send(Press.enter);
    await settle();
    expect(tty.output()).toContain('already has files in it (notes.ts)');

    tty.send('y');
    expect((await answers).force).toBe(true);
  });

  test('a fresh git repository is not files in the way', async () => {
    const cwd = workspace();
    await Bun.write(join(cwd, 'app', '.git', 'HEAD'), 'ref: refs/heads/main\n');
    const { tty, answers } = await start(cwd, { target: 'app' });

    tty.send(Press.enter);

    expect((await answers).force).toBe(false);
    expect(tty.opened).toBe(1);
  });

  test('answering no to that question writes nothing', async () => {
    const cwd = workspace();
    await Bun.write(join(cwd, 'app', 'notes.ts'), 'export {};');
    const { tty, answers } = await start(cwd, { target: 'app' });

    tty.send(Press.enter);
    await settle();
    tty.send('n');

    expect(answers).rejects.toBeInstanceOf(CancelledError);
    await answers.catch(() => undefined);
  });

  test('the list names what a choice pulls in, before it is made', async () => {
    const { tty, answers } = await start(workspace(), { features: ['users'] });

    // `users` needs the database, which the user never chose.
    expect(tty.output()).toContain('database comes along as a requirement');
    expect(tty.output()).toContain('◈ database');

    tty.send(Press.enter);
    expect((await answers).features).toEqual(['users']);
  });

  test('the list names the services a choice needs to do anything', async () => {
    const { tty, answers } = await start(workspace(), { features: ['jobs'] });

    expect(tty.output()).toContain('Redis or Valkey');

    tty.send(Press.enter);
    await answers;
  });

  test('Ctrl+C at any question stops the run', async () => {
    const { tty, answers } = await start(workspace());

    tty.send(Press.interrupt);

    expect(answers).rejects.toBeInstanceOf(CancelledError);
    await answers.catch(() => undefined);
  });
});

describe('slug', () => {
  test('turns a directory name npm refuses into one it takes', () => {
    expect(slug('My-API')).toBe('my-api');
    expect(slug('Some Service!')).toBe('some-service');
    expect(slug('_hidden')).toBe('hidden');
  });

  test('falls back rather than returning an empty name', () => {
    expect(slug('___')).toBe('my-api');
  });
});
