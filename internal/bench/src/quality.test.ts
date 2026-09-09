import { describe, expect, it } from 'bun:test';
import {
  BAD_RATE_FLOOR,
  badRate,
  formatBadRate,
  invalidates,
} from './quality.js';

describe('invalidates', () => {
  /*
   * The two real measurements the threshold sits between. A count-based rule
   * treated them identically, which is what made it the wrong rule.
   */
  it('ranks the one blip Django answered in 38,909 requests', () => {
    expect(invalidates(1, 38_909)).toBe(false);
    expect(formatBadRate(1, 38_909)).toBe('0.0026%');
  });

  it('unranks two Node subjects that answered nothing but connection failures', () => {
    expect(invalidates(3_367_249, 3_367_249)).toBe(true);
  });

  it('unranks a subject serving 5xx for a fifth of its requests', () => {
    expect(invalidates(19_399, 66_000)).toBe(true);
  });

  it('ranks a clean row', () => {
    expect(invalidates(0, 100_000)).toBe(false);
    expect(badRate(0, 0)).toBe(0);
  });

  it('treats a row that completed no requests as nothing but failure', () => {
    // Dividing by zero would make it `Infinity`, or `NaN` for a zero count -
    // and a `NaN` comparison is false, which would rank it first.
    expect(badRate(5, 0)).toBe(1);
    expect(invalidates(5, 0)).toBe(true);
    expect(invalidates(0, 0)).toBe(false);
  });

  it('is exclusive at the floor, so exactly one in a thousand still ranks', () => {
    expect(invalidates(1, 1 / BAD_RATE_FLOOR)).toBe(false);
    expect(invalidates(2, 1 / BAD_RATE_FLOOR)).toBe(true);
  });
});
