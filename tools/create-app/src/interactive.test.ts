import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The CLI answered through a real pseudo-terminal.
 *
 * `Bun.spawn({ terminal })` is the half `MemoryTty` cannot stand in for: the child
 * sees `process.stdin.isTTY === true`, `setRawMode` exists, and an arrow key
 * arrives as the three bytes `1b 5b 41` rather than a line. Everything asserted
 * here is a property of `ProcessTty` and of raw mode itself, including the one
 * that has no in-process equivalent - that the process exits when the questions
 * are over, rather than sitting on a stdin handle it never released.
 */
const CLI = new URL('./cli.ts', import.meta.url).pathname;

const made: string[] = [];
const workspace = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dunx-pty-'));
  made.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of made.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const ESC = '\u001b';
const DOWN = `${ESC}[B`;
const ENTER = '\r';

class Session {
  #output = '';
  readonly #terminal: Bun.Terminal;
  readonly #process: Bun.Subprocess;

  constructor(cwd: string, args: readonly string[]) {
    this.#terminal = new Bun.Terminal({
      cols: 100,
      rows: 30,
      data: (_terminal, data) => {
        this.#output += new TextDecoder().decode(data);
      },
    });
    this.#process = Bun.spawn(['bun', CLI, ...args], {
      cwd,
      terminal: this.#terminal,
      env: { ...process.env, NO_COLOR: '1' },
    });
  }

  /** The frames written so far, with the ANSI taken off. */
  get screen(): string {
    return Bun.stripANSI(this.#output);
  }

  /** Waits for the prompt to say it is ready for the next answer. */
  async waitFor(text: string): Promise<void> {
    const deadline = Bun.nanoseconds() + 15_000_000_000;
    while (!this.screen.includes(text)) {
      if (Bun.nanoseconds() > deadline) {
        throw new Error(`Never saw ${text}. Screen:\n${this.screen}`);
      }
      await Bun.sleep(25);
    }
  }

  async press(...keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      this.#terminal.write(key);
      await Bun.sleep(60);
    }
  }

  /** The exit code, or a failure naming what was on screen when it hung. */
  async exited(): Promise<number> {
    const code = await Promise.race([
      this.#process.exited,
      Bun.sleep(15_000).then(() => 'hung' as const),
    ]);
    if (code === 'hung') {
      this.#process.kill();
      throw new Error(`The CLI never exited. Screen:\n${this.screen}`);
    }
    this.#terminal.close();
    return code;
  }
}

describe('the CLI through a real terminal', () => {
  test('asks, takes the selection, and exits on its own', async () => {
    const cwd = workspace();
    const session = new Session(cwd, ['billing']);

    await session.waitFor('Space toggles');
    // Down onto `openapi`, toggle it, take the selection.
    await session.press(DOWN, ' ', ENTER);

    expect(await session.exited()).toBe(0);
    expect(session.screen).toContain('Features  openapi');
    expect(session.screen).toContain('bun install');
    expect(
      existsSync(join(cwd, 'billing', 'src', 'docs', 'docs.module.ts')),
    ).toBe(true);
  }, 30_000);

  test('the list names the requirement a choice pulls in', async () => {
    const cwd = workspace();
    const session = new Session(cwd, ['billing']);

    await session.waitFor('Space toggles');
    // `users` is the sixth entry, and it needs the database above it.
    await session.press(DOWN, DOWN, DOWN, DOWN, DOWN, ' ');
    await session.waitFor('comes along as a requirement');
    await session.press(ENTER);

    expect(await session.exited()).toBe(0);
    expect(existsSync(join(cwd, 'billing', 'src', 'database'))).toBe(true);
  }, 30_000);

  test('Ctrl+C writes nothing and reports the shell code for it', async () => {
    const cwd = workspace();
    const session = new Session(cwd, ['billing']);

    await session.waitFor('Space toggles');
    // Raw mode delivers this as a byte rather than a signal, so nothing ends the
    // process unless the CLI does.
    await session.press('\u0003');

    expect(await session.exited()).toBe(130);
    expect(existsSync(join(cwd, 'billing'))).toBe(false);
  }, 30_000);

  test('asks for the directory when the command line named none', async () => {
    const cwd = workspace();
    const session = new Session(cwd, []);

    await session.waitFor('Directory');
    await session.press(ENTER);
    await session.waitFor('Space toggles');
    await session.press(ENTER);

    expect(await session.exited()).toBe(0);
    expect(session.screen).toContain('Directory  my-api');
    expect(existsSync(join(cwd, 'my-api', 'src', 'main.ts'))).toBe(true);
  }, 30_000);

  test('a pipe is not a terminal, so it answers nothing and writes the minimum', async () => {
    const cwd = workspace();
    const proc = Bun.spawn(['bun', CLI, 'billing'], {
      cwd,
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const code = await Promise.race([
      proc.exited,
      Bun.sleep(15_000).then(() => 'hung' as const),
    ]);

    expect(code).toBe(0);
    expect(existsSync(join(cwd, 'billing', 'src', 'main.ts'))).toBe(true);
  }, 30_000);
});
