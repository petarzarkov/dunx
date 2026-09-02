import { describe, expect, test } from 'bun:test';
import type { Key } from './keys.js';
import { ProcessTty, type FrameSink, type KeySource } from './tty.js';

/** A stdin that records what raw mode was asked of it and hands over bytes. */
class FakeInput implements KeySource {
  readonly raw: boolean[] = [];
  readonly flow: string[] = [];
  #listeners: ((chunk: Uint8Array) => void)[] = [];

  setRawMode(enabled: boolean): void {
    this.raw.push(enabled);
  }

  resume(): void {
    this.flow.push('resume');
  }

  pause(): void {
    this.flow.push('pause');
  }

  on(_event: 'data', listener: (chunk: Uint8Array) => void): void {
    this.#listeners.push(listener);
  }

  off(_event: 'data', listener: (chunk: Uint8Array) => void): void {
    this.#listeners = this.#listeners.filter((each) => each !== listener);
  }

  get listeners(): number {
    return this.#listeners.length;
  }

  emit(text: string): void {
    const chunk = new TextEncoder().encode(text);
    for (const listener of this.#listeners.slice()) listener(chunk);
  }
}

class FakeOutput implements FrameSink {
  readonly written: string[] = [];

  constructor(
    readonly columns?: number,
    readonly rows?: number,
  ) {}

  write(text: string): void {
    this.written.push(text);
  }
}

describe('ProcessTty', () => {
  test('takes the terminal size from the stream it writes to', () => {
    const tty = new ProcessTty(new FakeInput(), new FakeOutput(120, 40));

    expect(tty.columns).toBe(120);
    expect(tty.rows).toBe(40);
  });

  test('falls back to 80x24 when the stream reports no size', () => {
    const tty = new ProcessTty(new FakeInput(), new FakeOutput());

    expect(tty.columns).toBe(80);
    expect(tty.rows).toBe(24);
  });

  test('writes frames straight through', () => {
    const output = new FakeOutput();
    new ProcessTty(new FakeInput(), output).write('frame');

    expect(output.written).toEqual(['frame']);
  });

  test('turns raw mode on to read, and off again to let the process exit', () => {
    const input = new FakeInput();
    const tty = new ProcessTty(input, new FakeOutput());

    tty.open(() => undefined);
    expect(input.raw).toEqual([true]);
    expect(input.flow).toEqual(['resume']);
    expect(input.listeners).toBe(1);

    tty.close();
    expect(input.raw).toEqual([true, false]);
    expect(input.flow).toEqual(['resume', 'pause']);
    expect(input.listeners).toBe(0);
  });

  test('decodes the bytes a terminal sends into keys', () => {
    const input = new FakeInput();
    const seen: Key[] = [];
    new ProcessTty(input, new FakeOutput()).open((key) => seen.push(key));

    input.emit('\u001b[Ba');

    expect(seen.map((key) => key.name)).toEqual(['down', 'char']);
    expect(seen.at(-1)?.char).toBe('a');
  });

  test('closing twice is not a second detach', () => {
    const input = new FakeInput();
    const tty = new ProcessTty(input, new FakeOutput());

    tty.open(() => undefined);
    tty.close();
    tty.close();

    expect(input.raw).toEqual([true, false]);
  });

  test('a stdin with no raw mode is read from anyway rather than throwing', () => {
    // What a pipe looks like. `available()` keeps the CLI off this path, and the
    // optional call is what stops a mistake there being a crash.
    const input = new FakeInput();
    const stripped: KeySource = {
      resume: () => input.resume(),
      pause: () => input.pause(),
      on: (event, listener) => input.on(event, listener),
      off: (event, listener) => input.off(event, listener),
    };
    const tty = new ProcessTty(stripped, new FakeOutput());

    tty.open(() => undefined);
    tty.close();

    expect(input.flow).toEqual(['resume', 'pause']);
  });

  test('a test runner is not a terminal, so it reports itself unavailable', () => {
    // `bun test` pipes both streams. The CLI reads this to decide whether to ask.
    expect(ProcessTty.available()).toBe(process.stdout.isTTY === true);
  });
});
