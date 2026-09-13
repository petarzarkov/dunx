import { describe, expect, it } from 'bun:test';
import { methodColor } from './colors.js';

/**
 * The mapping is the shared vocabulary: the same verb has to read the same on the
 * documentation site and on the dashboard. The assertions are here rather than in
 * one consumer's suite because a second consumer changing one is exactly the
 * regression worth catching.
 */
describe('methodColor', () => {
  it('agrees whichever case the caller has', () => {
    // `routesOf` reports GET; an OpenAPI document says get. Both are real inputs.
    expect(methodColor('GET')).toBe(methodColor('get'));
    expect(methodColor('DELETE')).toBe('red');
  });

  it('is grey for a verb neither dunx type models', () => {
    expect(methodColor('HEAD')).toBe('gray');
    expect(methodColor('OPTIONS')).toBe('gray');
  });
});
