import { describe, expect, test } from 'bun:test';
import { Banner } from './banner.js';
import { Style } from './style.js';

const CSI = '\u001b[';
const plain = new Banner(new Style(false));

describe('Banner', () => {
  test('draws the logo and names the version under it', () => {
    const lines = plain.lines(100, '3.0.3');

    expect(lines).toHaveLength(7);
    expect(lines.at(-1)).toContain('create-app 3.0.3');
  });

  test('fits the terminal it was given', () => {
    for (const width of [39, 60, 100, 200]) {
      for (const line of plain.lines(width, '3.0.3')) {
        expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test('falls back to one line rather than wrapping the logo', () => {
    const lines = plain.lines(30, '3.0.3');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('dunx');
    expect(lines[0]).toContain('create-app 3.0.3');
    expect(Bun.stringWidth(lines[0] ?? '')).toBeLessThanOrEqual(30);
  });

  test('colours each row of the logo, and only when colour is on', () => {
    const painted = new Banner(new Style(true)).lines(100, '3.0.3');

    // One SGR pair per row, so the gradient is per line rather than per file.
    expect(painted.filter((line) => line.includes(CSI)).length).toBe(7);
    expect(plain.lines(100, '3.0.3').join('')).not.toContain(CSI);
  });
});
