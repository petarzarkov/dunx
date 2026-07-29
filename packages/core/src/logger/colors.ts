import { LogLevel } from './types.js';

const RESET = '\x1b[0m';

/**
 * Replaces `@arkv/colors` — a JavaScript colour library — with `Bun.color`,
 * which resolves any CSS colour to an SGR sequence natively. Hex rather than
 * colour names so the palette is explicit; `Bun.color(x, 'ansi-256')` maps each
 * to the closest 256-colour index.
 *
 * `'ansi-256'` rather than plain `'ansi'`, which is not a fixed encoding: it is
 * whatever the *current* terminal is judged to support, so the palette would
 * depend on the environment at import time. Measured on Bun 1.3.14: `NO_COLOR=1`
 * makes `'ansi'` return `''`, and `FORCE_COLOR=1` makes it fall back to
 * `'ansi-16'`, which emits the colour index as a **raw byte** rather than decimal
 * digits — index 10 is `\n`, so a green field would put a literal newline inside a
 * log entry and split one record into two. `'ansi-256'` is well-formed in every
 * environment. Whether colour is used at all is `colorsSupported()`'s decision,
 * not the palette's.
 */
const HEX = Object.freeze({
  black: '#000000',
  red: '#cd0000',
  green: '#00cd00',
  yellow: '#cdcd00',
  blue: '#5c5cff',
  magenta: '#cd00cd',
  gray: '#7f7f7f',
  white: '#e5e5e5',
  brightGreen: '#00ff00',
  brightYellow: '#ffff00',
  brightBlue: '#8080ff',
  brightMagenta: '#ff00ff',
  brightCyan: '#00ffff',
  brightWhite: '#ffffff',
} as const);

/** `Bun.color` returns `null` only for input it cannot parse. */
const fg = (hex: string): string => Bun.color(hex, 'ansi-256') ?? '';

/**
 * `Bun.color` emits foreground sequences only. `38` is the foreground selector
 * and `48` its background counterpart, so the background form is the same
 * sequence with that one parameter changed.
 */
const bg = (hex: string): string => fg(hex).replace('[38;', '[48;');

export const PALETTE = Object.freeze({
  key: fg(HEX.gray),
  green: fg(HEX.green),
  magenta: fg(HEX.magenta),
  yellow: fg(HEX.yellow),
  red: fg(HEX.red),
  gray: fg(HEX.gray),
  white: fg(HEX.white),
  brightGreen: fg(HEX.brightGreen),
  brightBlue: fg(HEX.brightBlue),
  brightCyan: fg(HEX.brightCyan),
  brightMagenta: fg(HEX.brightMagenta),
  brightYellow: fg(HEX.brightYellow),
} as const);

const LEVEL_COLORS: Readonly<Record<LogLevel, string>> = Object.freeze({
  [LogLevel.FATAL]: `${bg(HEX.red)}${fg(HEX.brightWhite)}`,
  [LogLevel.ERROR]: fg(HEX.red),
  [LogLevel.WARN]: fg(HEX.yellow),
  [LogLevel.LOG]: `${bg(HEX.green)}${fg(HEX.black)}`,
  [LogLevel.DEBUG]: fg(HEX.blue),
  [LogLevel.VERBOSE]: fg(HEX.gray),
});

export const levelColor = (level: LogLevel): string => LEVEL_COLORS[level];

/**
 * Booleans and numbers yellow, `null` gray, everything else white — applied to
 * the raw JSON fragment, so a quoted string never parses as a number.
 */
export const valueColor = (value: string): string => {
  if (value === 'null') return PALETTE.gray;
  if (value === 'true' || value === 'false') return PALETTE.yellow;
  if (value !== '' && !Number.isNaN(Number(value))) return PALETTE.yellow;
  return PALETTE.white;
};

export const paint = (open: string, text: string): string =>
  open === '' ? text : `${open}${text}${RESET}`;

/**
 * Bun's own answer to the question, so `NO_COLOR`, `FORCE_COLOR` and whether
 * stdout is a TTY are all honoured by the runtime rather than re-derived here.
 * Verified: `NO_COLOR=1` gives `false`, `FORCE_COLOR=1` gives `true`, and a
 * piped stdout gives `false`.
 */
export const colorsSupported = (): boolean => Bun.enableANSIColors;
