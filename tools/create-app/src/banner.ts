import type { Style } from './style.js';

/**
 * The logo, 35 columns wide. Written out rather than assembled from a glyph table:
 * it is read far more often than it is edited, and a table would be a font.
 */
const LOGO: readonly string[] = [
  '██████╗ ██╗   ██╗███╗   ██╗██╗  ██╗',
  '██╔══██╗██║   ██║████╗  ██║╚██╗██╔╝',
  '██║  ██║██║   ██║██╔██╗ ██║ ╚███╔╝ ',
  '██║  ██║██║   ██║██║╚██╗██║ ██╔██╗ ',
  '██████╔╝╚██████╔╝██║ ╚████║██╔╝ ██╗',
  '╚═════╝  ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝',
];

/** Teal into blue, one entry per logo row. */
const RAMP: readonly string[] = [
  '#00e6b8',
  '#00d4aa',
  '#12bfa4',
  '#1fa89c',
  '#2b8f92',
  '#357788',
];

const INDENT = '  ';

/** Two columns of indent either side of the widest row. */
const NEEDS = 2 + 35 + 2;

/**
 * The header the questions run under.
 *
 * Printed once, before the first prompt, and only when there is a terminal to
 * print it into: a logo piped into a log file is noise. A terminal too narrow for
 * the logo gets the one-line form rather than a wrapped one, which is what
 * `Bun.stringWidth` is measured against.
 */
export class Banner {
  readonly #style: Style;

  constructor(style: Style) {
    this.#style = style;
  }

  lines(width: number, version: string): readonly string[] {
    const label = `create-app ${version}`;
    if (width < NEEDS) {
      return [
        `${INDENT}${this.#style.bold(this.#style.accent('dunx'))} ${this.#style.muted(label)}`,
      ];
    }
    return [
      ...LOGO.map(
        (row, at) => `${INDENT}${this.#style.hex(RAMP[at] ?? '#00d4aa', row)}`,
      ),
      `${INDENT}${this.#style.muted(label)}`,
    ];
  }
}
