const CSI = '\u001b[';
const RESET = `${CSI}0m`;

/**
 * `'ansi-256'` rather than `'ansi'`: the latter returns whatever the current
 * terminal is judged to support, so the same call gives different bytes on
 * different machines. Pinning the encoding is the advice in docs/bun-apis.md,
 * `Bun.color`.
 */
const tone = (hex: string): string => Bun.color(hex, 'ansi-256') ?? '';

const ACCENT = tone('#00d4aa');
const MUTED = tone('#8a8f98');
const DANGER = tone('#e5534b');
const WARN = tone('#d29922');

/**
 * ANSI styling, and the switch that turns it off.
 *
 * `Bun.enableANSIColors` is the capability check rather than a `TERM` sniff: it is
 * false under `NO_COLOR` and for a non-TTY, and it cannot be faked in-process.
 * Tests construct one with the switch off and assert on plain text.
 */
export class Style {
  readonly #enabled: boolean;

  constructor(enabled: boolean = Bun.enableANSIColors) {
    this.#enabled = enabled;
  }

  #wrap(code: string, text: string): string {
    return this.#enabled && code !== '' ? `${code}${text}${RESET}` : text;
  }

  accent(text: string): string {
    return this.#wrap(ACCENT, text);
  }

  muted(text: string): string {
    return this.#wrap(MUTED, text);
  }

  danger(text: string): string {
    return this.#wrap(DANGER, text);
  }

  warn(text: string): string {
    return this.#wrap(WARN, text);
  }

  bold(text: string): string {
    return this.#wrap(`${CSI}1m`, text);
  }

  /** Reverse video, which is how the text cursor is drawn over a character. */
  invert(text: string): string {
    return this.#wrap(`${CSI}7m`, text);
  }

  /** An arbitrary colour, for the one place a gradient needs more than four. */
  hex(colour: string, text: string): string {
    return this.#wrap(tone(colour), text);
  }

  /**
   * Clipped to `width` columns, measured the way a terminal measures them.
   * `Bun.stringWidth` counts columns rather than code units, and `Bun.sliceAnsi`
   * cuts by the same measure without severing an escape sequence.
   */
  clip(text: string, width: number): string {
    if (width <= 0) return '';
    if (Bun.stringWidth(text) <= width) return text;
    return `${Bun.sliceAnsi(text, 0, Math.max(0, width - 1))}${this.muted('…')}`;
  }
}
