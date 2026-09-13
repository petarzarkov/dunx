import { describe, expect, it } from 'bun:test';
import { SendPacer } from './pacer.js';

describe('SendPacer', () => {
  it('is unpaced at zero', async () => {
    const pacer = new SendPacer(0);
    expect(pacer.minIntervalMs).toBe(0);

    const started = performance.now();
    await Promise.all([pacer.wait(), pacer.wait(), pacer.wait()]);

    expect(performance.now() - started).toBeLessThan(20);
  });

  it('is unpaced for a non-finite or negative cap', () => {
    expect(new SendPacer(Number.POSITIVE_INFINITY).minIntervalMs).toBe(0);
    expect(new SendPacer(Number.NaN).minIntervalMs).toBe(0);
    expect(new SendPacer(-1).minIntervalMs).toBe(0);
  });

  it('rounds the interval up, so the cap is never exceeded', () => {
    expect(new SendPacer(3).minIntervalMs).toBe(334);
    expect(new SendPacer(2).minIntervalMs).toBe(500);
  });

  it('lets the first caller through at once', async () => {
    const pacer = new SendPacer(1);

    const started = performance.now();
    await pacer.wait();

    expect(performance.now() - started).toBeLessThan(20);
  });

  it('spaces the callers after it', async () => {
    const pacer = new SendPacer(20);
    const at: number[] = [];

    const started = performance.now();
    await Promise.all(
      [0, 1, 2].map(async () => {
        await pacer.wait();
        at.push(performance.now() - started);
      }),
    );

    expect(at).toHaveLength(3);
    // Three starts at 50ms apart is 100ms of waiting, the first being free.
    // The bound is loose because `Bun.sleep` may return a hair early.
    expect(Math.max(...at)).toBeGreaterThanOrEqual(90);
  });

  it('orders waiters by arrival', async () => {
    const pacer = new SendPacer(200);
    const order: number[] = [];

    await Promise.all(
      [0, 1, 2, 3].map(async (n) => {
        await pacer.wait();
        order.push(n);
      }),
    );

    expect(order).toEqual([0, 1, 2, 3]);
  });
});
