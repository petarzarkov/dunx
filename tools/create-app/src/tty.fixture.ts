import { KeyDecoder, type Key } from './keys.js';
import { Tty } from './tty.js';

/**
 * A terminal that records what was written instead of writing it, and delivers
 * keys when a test says so.
 *
 * Every prompt and `PromptRunner` run against this in-process, so the suite
 * exercises the same code path a real terminal does with none of the setup. The
 * one thing it cannot prove is that `ProcessTty` drives an actual TTY correctly,
 * which is what `interactive.test.ts` spawns a PTY for.
 */
export class MemoryTty extends Tty {
  readonly writes: string[] = [];
  readonly #decoder = new KeyDecoder();
  #onKey: ((key: Key) => void) | undefined;
  #opened = 0;
  #closed = 0;

  constructor(
    readonly columns = 80,
    readonly rows = 24,
  ) {
    super();
  }

  override write(text: string): void {
    this.writes.push(text);
  }

  override open(onKey: (key: Key) => void): void {
    this.#onKey = onKey;
    this.#opened += 1;
  }

  override close(): void {
    this.#onKey = undefined;
    this.#closed += 1;
  }

  get opened(): number {
    return this.#opened;
  }

  get closed(): number {
    return this.#closed;
  }

  /** Bytes as a terminal would send them, decoded and delivered. */
  send(...chunks: string[]): void {
    for (const chunk of chunks) {
      for (const key of this.#decoder.push(new TextEncoder().encode(chunk))) {
        this.#onKey?.(key);
      }
    }
  }

  /** Everything written so far, with the ANSI taken off. */
  output(): string {
    return Bun.stripANSI(this.writes.join(''));
  }

  /** The last write alone: the closing summary, once a prompt is answered. */
  last(): string {
    return Bun.stripANSI(this.writes.at(-1) ?? '');
  }
}

const ESC = '\u001b';

/** The byte sequences a terminal sends, named. */
export const Press = Object.freeze({
  up: `${ESC}[A`,
  down: `${ESC}[B`,
  left: `${ESC}[D`,
  right: `${ESC}[C`,
  home: `${ESC}[H`,
  end: `${ESC}[F`,
  shiftTab: `${ESC}[Z`,
  escape: ESC,
  enter: '\r',
  space: ' ',
  tab: '\t',
  backspace: '\u007f',
  clearLine: '\u0015',
  interrupt: '\u0003',
});
