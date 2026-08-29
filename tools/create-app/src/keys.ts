/**
 * The keys a prompt acts on. Everything else a terminal can send decodes to
 * `Char` when it is printable and `Unknown` when it is not, so a prompt never has
 * to know what a function key looks like.
 */
export const KeyName = Object.freeze({
  Up: 'up',
  Down: 'down',
  Left: 'left',
  Right: 'right',
  Home: 'home',
  End: 'end',
  Enter: 'enter',
  Space: 'space',
  Tab: 'tab',
  ShiftTab: 'shiftTab',
  Backspace: 'backspace',
  ClearLine: 'clearLine',
  Escape: 'escape',
  Interrupt: 'interrupt',
  Char: 'char',
  Unknown: 'unknown',
} as const);
export type KeyName = (typeof KeyName)[keyof typeof KeyName];

export interface Key {
  readonly name: KeyName;
  /** What the key typed. Empty for every name but `Char`. */
  readonly char: string;
}

const key = (name: KeyName, char = ''): Key => ({ name, char });

/** Bytes below 0x20, plus DEL, mapped to the names the prompts bind. */
const CONTROLS: Readonly<Record<number, KeyName>> = Object.freeze({
  0x03: KeyName.Interrupt,
  // Ctrl+D on a prompt means "I am not answering this", which is a cancel.
  0x04: KeyName.Interrupt,
  0x08: KeyName.Backspace,
  0x09: KeyName.Tab,
  0x0a: KeyName.Enter,
  0x0d: KeyName.Enter,
  0x15: KeyName.ClearLine,
  0x20: KeyName.Space,
  0x7f: KeyName.Backspace,
});

/** CSI final bytes. `ESC [ A` and the application-mode `ESC O A` share these. */
const FINALS: Readonly<Record<string, KeyName>> = Object.freeze({
  A: KeyName.Up,
  B: KeyName.Down,
  C: KeyName.Right,
  D: KeyName.Left,
  F: KeyName.End,
  H: KeyName.Home,
  Z: KeyName.ShiftTab,
});

/** `ESC [ <n> ~` forms, keyed by the numeric parameter. */
const TILDES: Readonly<Record<string, KeyName>> = Object.freeze({
  '1': KeyName.Home,
  '4': KeyName.End,
  '7': KeyName.Home,
  '8': KeyName.End,
});

const ESCAPE = 0x1b;

/** Parameter and intermediate bytes, which sit between `[` and the final byte. */
const isParameter = (code: number): boolean => code >= 0x20 && code <= 0x3f;

/**
 * Bytes from a raw-mode terminal, decoded into keys.
 *
 * A class rather than a function because two things have to survive between
 * reads: a half-arrived escape sequence, and a UTF-8 code point split across the
 * chunk boundary. `TextDecoder` in streaming mode holds the second; `#pending`
 * holds the first, and an incomplete sequence is kept rather than guessed at.
 *
 * The one guess it does make: a chunk holding nothing but `0x1b` reads as the
 * Escape key. A terminal that split that byte from the `[A` behind it across two
 * reads would have it read as Escape followed by nothing bindable. Bun's PTY and every terminal
 * measured deliver a sequence in one read - `1b 5b 41` arrived as one chunk on
 * Bun 1.4.0, docs/bun-apis.md - and the alternative is a timer that delays every
 * real Escape.
 */
export class KeyDecoder {
  #pending = '';
  readonly #decoder = new TextDecoder('utf-8');

  push(bytes: Uint8Array): readonly Key[] {
    this.#pending += this.#decoder.decode(bytes, { stream: true });
    const keys: Key[] = [];
    while (this.#pending.length > 0) {
      const next = this.#take();
      if (next === undefined) break;
      keys.push(next);
    }
    return keys;
  }

  /** One key off the front, or `undefined` while the sequence is incomplete. */
  #take(): Key | undefined {
    const buffer = this.#pending;
    const code = buffer.charCodeAt(0);
    if (code === ESCAPE) return this.#takeEscape(buffer);

    const named = CONTROLS[code];
    if (named !== undefined) {
      this.#pending = buffer.slice(1);
      return key(named);
    }
    if (code < 0x20) {
      this.#pending = buffer.slice(1);
      return key(KeyName.Unknown);
    }

    // A surrogate pair is one character to a reader and has to stay one here, or
    // backspace would leave half of it in the value.
    const size = code >= 0xd800 && code <= 0xdbff ? 2 : 1;
    this.#pending = buffer.slice(size);
    return key(KeyName.Char, buffer.slice(0, size));
  }

  #takeEscape(buffer: string): Key | undefined {
    if (buffer.length === 1) {
      this.#pending = '';
      return key(KeyName.Escape);
    }

    const introducer = buffer[1];
    if (introducer !== '[' && introducer !== 'O') {
      // Alt+something. Nothing binds it, and dropping both characters keeps the
      // bare letter from arriving as a toggle the user did not type.
      this.#pending = buffer.slice(2);
      return key(KeyName.Unknown);
    }

    let at = 2;
    while (at < buffer.length && isParameter(buffer.charCodeAt(at))) at += 1;
    if (at === buffer.length) return undefined;

    const parameters = buffer.slice(2, at);
    const final = buffer[at] ?? '';
    this.#pending = buffer.slice(at + 1);
    if (final === '~') return key(TILDES[parameters] ?? KeyName.Unknown);
    return key(FINALS[final] ?? KeyName.Unknown);
  }
}
