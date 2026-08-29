import { KeyDecoder, type Key } from './keys.js';

/**
 * What a prompt needs from a terminal, and nothing else.
 *
 * An abstract class rather than an interface so the fake the tests drive is the
 * same shape the real one is, checked by the compiler. `ProcessTty` is the real
 * one; `tty.fixture.ts` holds the one that records frames instead of writing them.
 */
export abstract class Tty {
  abstract get columns(): number;
  abstract get rows(): number;
  abstract write(text: string): void;
  /** Raw mode on, decoded keys to `onKey`. */
  abstract open(onKey: (key: Key) => void): void;
  /** Raw mode off, and the read released so the process can exit. */
  abstract close(): void;
}

/** The half of `process.stdin` that reading keys in raw mode uses. */
export interface KeySource {
  readonly isTTY?: boolean | undefined;
  setRawMode?(enabled: boolean): unknown;
  resume(): unknown;
  pause(): unknown;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  off(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
}

/** The half of `process.stdout` that a frame is written to. */
export interface FrameSink {
  readonly columns?: number | undefined;
  readonly rows?: number | undefined;
  write(text: string): unknown;
}

/**
 * `process.stdin` in raw mode, `process.stdout` for the frames.
 *
 * Raw mode turns an arrow key into three bytes this process reads rather than a
 * line the terminal buffers, and stops the terminal echoing keystrokes over the
 * frame. It also makes `close()` load bearing twice over: Ctrl+C arrives as a byte
 * with no `SIGINT` behind it, and the read holds the event loop open until the
 * listener is removed. Both measured in docs/bun-apis.md, "Raw-mode stdin".
 *
 * The streams are arguments so the suite can drive this without a terminal;
 * `interactive.test.ts` spawns a real one for what a fake cannot answer.
 */
export class ProcessTty extends Tty {
  readonly #decoder = new KeyDecoder();
  readonly #input: KeySource;
  readonly #output: FrameSink;
  #listener: ((chunk: Uint8Array) => void) | undefined;

  constructor(
    input: KeySource = process.stdin,
    output: FrameSink = process.stdout,
  ) {
    super();
    this.#input = input;
    this.#output = output;
  }

  /**
   * Whether this process can ask a question at all. Both halves are checked: a
   * piped stdin has no `setRawMode`, and a piped stdout has no width to draw into.
   */
  static available(): boolean {
    return (
      process.stdin.isTTY === true &&
      typeof process.stdin.setRawMode === 'function' &&
      process.stdout.isTTY === true
    );
  }

  override get columns(): number {
    return this.#output.columns ?? 80;
  }

  override get rows(): number {
    return this.#output.rows ?? 24;
  }

  override write(text: string): void {
    this.#output.write(text);
  }

  override open(onKey: (key: Key) => void): void {
    const listener = (chunk: Uint8Array): void => {
      for (const key of this.#decoder.push(chunk)) onKey(key);
    };
    this.#listener = listener;
    this.#input.setRawMode?.(true);
    this.#input.resume();
    this.#input.on('data', listener);
  }

  override close(): void {
    if (this.#listener === undefined) return;
    this.#input.off('data', this.#listener);
    this.#listener = undefined;
    this.#input.setRawMode?.(false);
    this.#input.pause();
  }
}
