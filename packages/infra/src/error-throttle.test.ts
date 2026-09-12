import { describe, expect, it } from 'bun:test';
import { ErrorThrottle } from './error-throttle.js';

/**
 * Shared by `/queue`'s worker and `/amqp`'s subscriber: a broker that is down
 * fails on every retry, and the log line that says so measured 21.9M lines in two
 * minutes before this existed.
 */
describe('ErrorThrottle', () => {
  it('reports one of a flood', () => {
    const report = new ErrorThrottle(30_000, () => 0);
    const reported = Array.from({ length: 10_000 }, () =>
      report.allows(),
    ).filter(Boolean);
    expect(reported).toHaveLength(1);
  });

  /**
   * Time rather than a "connected yet" gate: one cleared on the first success
   * would latch after one outage and silence every one after it.
   */
  it('reports a second outage once the interval has passed', () => {
    let at = 0;
    const report = new ErrorThrottle(1_000, () => at);

    expect(report.allows()).toBe(true);
    expect(report.allows()).toBe(false);
    at = 999;
    expect(report.allows()).toBe(false);
    at = 1_000;
    expect(report.allows()).toBe(true);
  });

  it('defaults its clock to the wall clock', () => {
    const report = new ErrorThrottle(30_000);
    expect(report.allows()).toBe(true);
    expect(report.allows()).toBe(false);
  });
});
