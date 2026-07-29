import { describe, expect, it } from 'bun:test';
import {
  colorsSupported,
  levelColor,
  PALETTE,
  paint,
  valueColor,
} from './colors.js';
import {
  captureConsole,
  hasColor,
  testConfig,
  testLogger,
} from './fixture.test.js';
import { LOG_LEVELS } from './types.js';

const ESC = 0x1b;

/**
 * The invariant that a colour library has to hold for a *log*: an SGR sequence
 * may contain ESC, digits and separators, and nothing else. `Bun.color`'s
 * `'ansi-16'` encoding violates it — it writes the colour index as a raw byte, so
 * index 10 is a newline and one entry becomes two records.
 */
const controlCharacters = (text: string): readonly number[] => {
  const found: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 && code !== ESC) found.push(code);
  }
  return found;
};

describe('palette', () => {
  it('contains no control characters other than ESC', () => {
    const offenders = Object.entries(PALETTE)
      .filter(([, sequence]) => controlCharacters(sequence).length > 0)
      .map(([name]) => name);

    expect(offenders).toEqual([]);
  });

  it('contains no control characters in any level colour', () => {
    const offenders = LOG_LEVELS.filter(
      (level) => controlCharacters(levelColor(level)).length > 0,
    );

    expect(offenders).toEqual([]);
  });

  it('paints reversibly', () => {
    const painted = paint(PALETTE.green, 'value');
    expect(hasColor(painted)).toBe(true);
    expect(Bun.stripANSI(painted)).toBe('value');
  });

  it('paints nothing when the colour is empty', () => {
    expect(paint('', 'value')).toBe('value');
  });

  it('colours values by their JSON shape', () => {
    expect(valueColor('null')).toBe(PALETTE.gray);
    expect(valueColor('true')).toBe(PALETTE.yellow);
    expect(valueColor('false')).toBe(PALETTE.yellow);
    expect(valueColor('42')).toBe(PALETTE.yellow);
    expect(valueColor('"42"')).toBe(PALETTE.white);
    expect(valueColor('"text"')).toBe(PALETTE.white);
  });

  it('reports the runtime decision on colour support', () => {
    expect(colorsSupported()).toBe(Bun.enableANSIColors);
  });
});

describe('coloured output', () => {
  it('stays on one line, stack and all', () => {
    const capture = captureConsole();
    try {
      testLogger(testConfig).error('boom', new Error('multi\nline'));
      const line = capture.line();
      expect(hasColor(line)).toBe(true);
      expect(line.split('\n')).toHaveLength(1);
      expect(capture.entry()).toMatchObject({
        message: 'boom',
        error: { message: 'multi\nline' },
      });
    } finally {
      capture.restore();
    }
  });
});
