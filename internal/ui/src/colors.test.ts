import { describe, expect, it } from 'bun:test';
import { jobStateColor, methodColor, statusColor } from './colors.js';

/**
 * These mappings are the shared vocabulary: the same verb, status or job state has
 * to read the same in the API explorer, the documentation site and the dashboard.
 * The assertions are here rather than in one consumer's suite because a second
 * consumer changing one of them is exactly the regression worth catching.
 */
describe('statusColor', () => {
  it('colours a status by its class, never by its digits', () => {
    expect(statusColor('200')).toBe('green');
    expect(statusColor('301')).toBe('cyan');
    expect(statusColor('404')).toBe('orange');
    expect(statusColor('500')).toBe('red');
  });

  it('takes a number as readily as a string', () => {
    expect(statusColor(204)).toBe('green');
    expect(statusColor(503)).toBe('red');
  });

  it('is grey for a key that is not a code', () => {
    expect(statusColor('default')).toBe('gray');
  });
});

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

describe('jobStateColor', () => {
  it('keeps bullmq’s own hyphenated state names', () => {
    expect(jobStateColor('waiting-children')).toBe('cyan');
    expect(jobStateColor('failed')).toBe('red');
  });

  it('is grey for a state a future bullmq adds', () => {
    expect(jobStateColor('repeat')).toBe('gray');
  });
});
