import { KeyName, type Key } from './keys.js';
import { Prompt } from './prompt.js';
import type { Style } from './style.js';

const ASKING = '?';
const ANSWERED = '✓';
const POINTER = '❯';
const CHOSEN = '◉';
const REQUIRED = '◈';
const UNCHOSEN = '○';

/** One line of free text, with the cursor drawn as reverse video over it. */
export class TextPrompt extends Prompt<string> {
  #value: string;
  #at: number;
  #error = '';

  constructor(
    protected readonly style: Style,
    readonly title: string,
    initial: string,
  ) {
    super();
    this.#value = initial;
    this.#at = initial.length;
  }

  /** An error to show instead of accepting, or `undefined` to accept. */
  protected validate(_value: string): string | undefined {
    return undefined;
  }

  /** The line under the field when there is nothing wrong with the value. */
  protected hint(): string {
    return 'Enter to accept. Ctrl+C to cancel.';
  }

  override frame(width: number): readonly string[] {
    const text = this.#value;
    const at = this.#at;
    const under = at < text.length ? text.slice(at, at + 1) : ' ';
    const drawn =
      text.slice(0, at) + this.style.invert(under) + text.slice(at + 1);
    const footer =
      this.#error === ''
        ? this.style.muted(this.hint())
        : this.style.danger(this.#error);
    return [
      `${this.style.accent(ASKING)} ${this.style.bold(this.title)}`,
      this.style.clip(`  ${drawn}`, width),
      this.style.clip(`  ${footer}`, width),
    ];
  }

  override summary(width: number): string {
    return this.style.clip(
      `${this.style.accent(ANSWERED)} ${this.title}  ${this.style.accent(this.#value)}`,
      width,
    );
  }

  protected override handle(key: Key): void {
    this.#error = '';
    switch (key.name) {
      case KeyName.Char:
        this.#value =
          this.#value.slice(0, this.#at) +
          key.char +
          this.#value.slice(this.#at);
        this.#at += key.char.length;
        return;
      case KeyName.Space:
        // A space is legal in neither a directory nor a package name, and typing
        // one by accident is easier than noticing it later in a shell quote.
        this.#error = 'A space is not usable here.';
        return;
      case KeyName.Backspace:
        if (this.#at === 0) return;
        this.#value =
          this.#value.slice(0, this.#at - 1) + this.#value.slice(this.#at);
        this.#at -= 1;
        return;
      case KeyName.ClearLine:
        this.#value = '';
        this.#at = 0;
        return;
      case KeyName.Left:
        this.#at = Math.max(0, this.#at - 1);
        return;
      case KeyName.Right:
        this.#at = Math.min(this.#value.length, this.#at + 1);
        return;
      case KeyName.Home:
        this.#at = 0;
        return;
      case KeyName.End:
        this.#at = this.#value.length;
        return;
      case KeyName.Enter: {
        const problem = this.validate(this.#value);
        if (problem === undefined) this.finish(this.#value);
        else this.#error = problem;
        return;
      }
      default:
        return;
    }
  }
}

/** Yes or no, defaulting to whichever the caller says is safe. */
export class ConfirmPrompt extends Prompt<boolean> {
  #value: boolean;

  constructor(
    private readonly style: Style,
    private readonly title: string,
    initial: boolean,
  ) {
    super();
    this.#value = initial;
  }

  #option(label: string, active: boolean): string {
    return active
      ? this.style.invert(` ${label} `)
      : this.style.muted(` ${label} `);
  }

  override frame(width: number): readonly string[] {
    return [
      `${this.style.accent(ASKING)} ${this.style.bold(this.title)}`,
      this.style.clip(
        `  ${this.#option('yes', this.#value)} ${this.#option('no', !this.#value)}`,
        width,
      ),
      this.style.clip(
        `  ${this.style.muted('y or n. Enter takes the highlighted one.')}`,
        width,
      ),
    ];
  }

  override summary(width: number): string {
    const answer = this.#value ? 'yes' : 'no';
    return this.style.clip(
      `${this.style.accent(ANSWERED)} ${this.title}  ${this.style.accent(answer)}`,
      width,
    );
  }

  protected override handle(key: Key): void {
    const typed = key.char.toLowerCase();
    if (typed === 'y') {
      this.finish(true);
      return;
    }
    if (typed === 'n') {
      this.finish(false);
      return;
    }
    if (
      key.name === KeyName.Left ||
      key.name === KeyName.Right ||
      key.name === KeyName.Tab ||
      key.name === KeyName.Space
    ) {
      this.#value = !this.#value;
      return;
    }
    if (key.name === KeyName.Enter) this.finish(this.#value);
  }
}

export interface SelectItem {
  readonly value: string;
  readonly label: string;
  readonly hint: string;
}

/** Lines around the list itself: title, footer, and the two overflow markers. */
const CHROME = 4;

/**
 * A multi-select list: space toggles, the arrows move, Enter takes the set.
 *
 * The list scrolls rather than being clipped, because eighteen features do not fit
 * a 24-row terminal alongside anything else. The window offset is the one piece of
 * state `frame` writes, since only `frame` is told how tall the terminal is.
 */
export class SelectPrompt extends Prompt<readonly string[]> {
  #cursor = 0;
  #offset = 0;
  readonly #chosen = new Set<string>();

  constructor(
    protected readonly style: Style,
    readonly title: string,
    protected readonly items: readonly SelectItem[],
    initial: readonly string[] = [],
  ) {
    super();
    for (const value of initial) this.#chosen.add(value);
  }

  /** Values the chosen set pulls in without the user having chosen them. */
  protected implied(_chosen: ReadonlySet<string>): ReadonlySet<string> {
    return new Set();
  }

  /** Lines between the list and the footer: what came along, what it needs. */
  protected notes(_chosen: ReadonlySet<string>): readonly string[] {
    return [];
  }

  #marker(value: string, implied: ReadonlySet<string>): string {
    if (this.#chosen.has(value)) return this.style.accent(CHOSEN);
    if (implied.has(value)) return this.style.warn(REQUIRED);
    return this.style.muted(UNCHOSEN);
  }

  #window(budget: number): readonly SelectItem[] {
    const visible = Math.max(1, Math.min(this.items.length, budget));
    if (this.#cursor < this.#offset) this.#offset = this.#cursor;
    if (this.#cursor >= this.#offset + visible) {
      this.#offset = this.#cursor - visible + 1;
    }
    this.#offset = Math.min(
      this.#offset,
      Math.max(0, this.items.length - visible),
    );
    return this.items.slice(this.#offset, this.#offset + visible);
  }

  override frame(width: number, height: number): readonly string[] {
    const implied = this.implied(this.#chosen);
    const notes = this.notes(this.#chosen);
    const pad = Math.max(...this.items.map((item) => item.label.length));
    const window = this.#window(height - CHROME - notes.length);
    const lines: string[] = [
      `${this.style.accent(ASKING)} ${this.style.bold(this.title)}  ` +
        this.style.muted(this.#count(implied)),
    ];

    if (this.#offset > 0) {
      lines.push(this.style.muted(`    ↑ ${this.#offset} more`));
    }
    for (const [index, item] of window.entries()) {
      const at = this.#offset + index;
      const pointer = at === this.#cursor ? this.style.accent(POINTER) : ' ';
      const label =
        at === this.#cursor
          ? this.style.bold(item.label.padEnd(pad))
          : item.label.padEnd(pad);
      lines.push(
        this.style.clip(
          `${pointer} ${this.#marker(item.value, implied)} ${label}  ${this.style.muted(item.hint)}`,
          width,
        ),
      );
    }
    const below = this.items.length - this.#offset - window.length;
    if (below > 0) lines.push(this.style.muted(`    ↓ ${below} more`));

    for (const note of notes) {
      lines.push(this.style.clip(`  ${this.style.warn(note)}`, width));
    }
    lines.push(
      this.style.clip(
        `  ${this.style.muted('Space toggles. ↑↓ moves. a all, n none. Enter continues.')}`,
        width,
      ),
    );
    return lines;
  }

  #count(implied: ReadonlySet<string>): string {
    if (this.#chosen.size === 0) return 'nothing chosen yet';
    const extra = implied.size === 0 ? '' : `, ${implied.size} pulled in`;
    return `${this.#chosen.size} chosen${extra}`;
  }

  override summary(width: number): string {
    const chosen = this.#ordered();
    const answer =
      chosen.length === 0 ? 'none, the minimal template' : chosen.join(', ');
    return this.style.clip(
      `${this.style.accent(ANSWERED)} ${this.title}  ${this.style.accent(answer)}`,
      width,
    );
  }

  /** The chosen values in list order, so two runs answer identically. */
  #ordered(): readonly string[] {
    return this.items
      .map((item) => item.value)
      .filter((value) => this.#chosen.has(value));
  }

  #move(by: number): void {
    const count = this.items.length;
    this.#cursor = (this.#cursor + by + count) % count;
  }

  protected override handle(key: Key): void {
    switch (key.name) {
      case KeyName.Up:
      case KeyName.ShiftTab:
        this.#move(-1);
        return;
      case KeyName.Down:
      case KeyName.Tab:
        this.#move(1);
        return;
      case KeyName.Home:
        this.#cursor = 0;
        return;
      case KeyName.End:
        this.#cursor = this.items.length - 1;
        return;
      case KeyName.Space: {
        const value = this.items[this.#cursor]?.value;
        if (value === undefined) return;
        if (!this.#chosen.delete(value)) this.#chosen.add(value);
        return;
      }
      case KeyName.Enter:
        this.finish(this.#ordered());
        return;
      case KeyName.Char:
        this.#type(key.char);
        return;
      default:
        return;
    }
  }

  #type(char: string): void {
    if (char === 'k') this.#move(-1);
    else if (char === 'j') this.#move(1);
    else if (char === 'a')
      for (const item of this.items) this.#chosen.add(item.value);
    else if (char === 'n') this.#chosen.clear();
  }
}
