import { levelColor, PALETTE, paint, valueColor } from './colors.js';
import { safeStringify } from './serialize.js';
import type { LogEntry, LogLevel } from './types.js';

/** Fields worth a fixed colour whatever they contain. */
const FIELD_COLORS: Readonly<Record<string, string>> = Object.freeze({
  message: PALETTE.green,
  timestamp: PALETTE.magenta,
  requestId: PALETTE.brightGreen,
  flow: PALETTE.brightGreen,
  userId: PALETTE.brightBlue,
  method: PALETTE.brightBlue,
  context: PALETTE.brightCyan,
  event: PALETTE.brightMagenta,
  duration: PALETTE.yellow,
  status: PALETTE.brightYellow,
  elapsed: PALETTE.brightYellow,
  error: PALETTE.red,
  exception: PALETTE.red,
  stack: PALETTE.gray,
});

/**
 * A `"key":` and as much of the value as runs to the next comma. Anything not
 * matched is left untouched, so the result is the same JSON with SGR sequences
 * interleaved — `Bun.stripANSI` reverses it exactly.
 */
const FIELD = /("[^"]*":\s*)([^,\n]*)/g;

export const formatColoredJson = (entry: LogEntry, level: LogLevel): string =>
  safeStringify(entry).replace(FIELD, (_match, key: string, value: string) => {
    const name = key.slice(1, key.lastIndexOf('"'));
    const color =
      name === 'level'
        ? levelColor(level)
        : (FIELD_COLORS[name] ?? valueColor(value));
    return `${paint(PALETTE.key, key)}${paint(color, value)}`;
  });
