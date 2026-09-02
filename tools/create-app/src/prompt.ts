import { KeyName, type Key } from './keys.js';
import type { Tty } from './tty.js';

export class CancelledError extends Error {
  override readonly name = 'CancelledError';
}

/**
 * One question, as a state machine over keypresses.
 *
 * Rendering is a pure function of the state and returns lines rather than writing
 * them, and `press` is the only way the state moves. Nothing here touches a
 * terminal, so every prompt is exercised in-process by feeding it keys and reading
 * the frame back; `PromptRunner` is the half that owns the real one.
 */
export abstract class Prompt<T> {
  #done = false;
  #cancelled = false;
  #answer: T | undefined;

  /** The interactive frame, one entry per line, within `width` and `height`. */
  abstract frame(width: number, height: number): readonly string[];

  /** The single line left in the scrollback once the question is answered. */
  abstract summary(width: number): string;

  protected abstract handle(key: Key): void;

  press(key: Key): void {
    if (this.#done) return;
    if (key.name === KeyName.Interrupt || key.name === KeyName.Escape) {
      this.#cancelled = true;
      this.#done = true;
      return;
    }
    this.handle(key);
  }

  protected finish(answer: T): void {
    this.#answer = answer;
    this.#done = true;
  }

  get done(): boolean {
    return this.#done;
  }

  get cancelled(): boolean {
    return this.#cancelled;
  }

  /** The answer. Reading it before `done`, or after a cancel, is a bug here. */
  get answer(): T {
    if (!this.#done || this.#cancelled) {
      throw new Error('The prompt was not answered.');
    }
    return this.#answer as T;
  }
}

const CSI = '\u001b[';
const HIDE_CURSOR = `${CSI}?25l`;
const SHOW_CURSOR = `${CSI}?25h`;
const ERASE_DOWN = `${CSI}0J`;
const up = (lines: number): string => (lines > 0 ? `${CSI}${lines}A` : '');

/**
 * Drives one prompt at a time against a real terminal.
 *
 * Repainting is "up N lines, erase to the bottom, write the frame" rather than an
 * alternate screen: the answered prompts stay in the scrollback above, which is
 * what makes the summary line a record of what was chosen rather than something
 * that vanishes on exit.
 *
 * Every line is clipped to the terminal's width and the frame to its height, so a
 * wrapped line can never make the cursor arithmetic wrong.
 */
export class PromptRunner {
  readonly #tty: Tty;

  constructor(tty: Tty) {
    this.#tty = tty;
  }

  async ask<T>(prompt: Prompt<T>): Promise<T> {
    const width = Math.max(20, this.#tty.columns - 1);
    let painted = 0;

    const paint = (): void => {
      const height = Math.max(3, this.#tty.rows - 1);
      const lines = prompt.frame(width, height).slice(0, height);
      this.#tty.write(`${up(painted)}${ERASE_DOWN}${lines.join('\n')}\n`);
      painted = lines.length;
    };

    this.#tty.write(HIDE_CURSOR);
    try {
      await new Promise<void>((resolve) => {
        paint();
        this.#tty.open((key) => {
          prompt.press(key);
          if (prompt.done) resolve();
          else paint();
        });
      });
    } finally {
      this.#tty.close();
      const closing = prompt.cancelled ? '' : `${prompt.summary(width)}\n`;
      this.#tty.write(`${up(painted)}${ERASE_DOWN}${closing}${SHOW_CURSOR}`);
    }

    if (prompt.cancelled) throw new CancelledError('Cancelled.');
    return prompt.answer;
  }
}
