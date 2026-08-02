import { describe, expect, it } from 'bun:test';
import { bumpVersion } from './bump.js';

describe('bumpVersion()', () => {
  it('bumps a version whose components are all non-zero', () => {
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4');
  });

  // Regression: the guards were `!major` / `!minor` / `!patch`, and 0 is falsy, so
  // every one of these threw `Invalid version`.
  it('bumps across a zero component', () => {
    expect(bumpVersion('0.0.0', 'major')).toBe('1.0.0');
    expect(bumpVersion('0.0.0', 'minor')).toBe('0.1.0');
    expect(bumpVersion('0.0.0', 'patch')).toBe('0.0.1');
    expect(bumpVersion('1.0.0', 'minor')).toBe('1.1.0');
    expect(bumpVersion('1.0.0', 'patch')).toBe('1.0.1');
    expect(bumpVersion('1.2.0', 'patch')).toBe('1.2.1');
    expect(bumpVersion('0.1.0', 'patch')).toBe('0.1.1');
  });

  it('rejects a version that is not three non-negative integers', () => {
    for (const invalid of [
      '1.2',
      '1.2.3.4',
      '1.2.x',
      'v1.2.3',
      '',
      '1.2.-1',
      '1.2.3-beta',
    ]) {
      expect(() => bumpVersion(invalid, 'patch')).toThrow(
        `Invalid version: ${invalid}`,
      );
    }
  });
});
