import { describe, expect, it, spyOn } from 'bun:test';
import { closeWithin } from './close-within.js';

/**
 * Shared by `@dunx/infra/queue`'s two closes and all three of
 * `@dunx/infra/amqp`'s, which had written the same race five times.
 */
describe('closeWithin', () => {
  /** bullmq's own shape: `close()` returns the promise it already started, so a
   * second call with `force` is the same pending promise and escalates nothing. */
  const bullmqLike = (settles: boolean) => {
    const calls: (boolean | undefined)[] = [];
    let closing: Promise<void> | undefined;
    return {
      calls,
      close(force?: boolean): Promise<void> {
        calls.push(force);
        closing ??= settles
          ? Promise.resolve()
          : new Promise<void>(() => {
              /* a close waiting on a broker that is gone */
            });
        return closing;
      },
    };
  };

  it('returns as soon as a close that finishes does', async () => {
    const worker = bullmqLike(true);
    const started = Bun.nanoseconds();
    expect(await closeWithin(worker, 5_000)).toBe(false);
    // Returned on the close, not on the bound.
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(1_000);
    expect(worker.calls).toEqual([undefined]);
  });

  it('stops waiting on a close that never finishes', async () => {
    const worker = bullmqLike(false);
    const started = Bun.nanoseconds();
    expect(await closeWithin(worker, 40)).toBe(true);
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
    // The point: it settles. Without the bound this test would never return.
    expect(elapsedMs).toBeGreaterThanOrEqual(35);
    expect(elapsedMs).toBeLessThan(2_000);
    // And it did not try to escalate, which bullmq would have ignored anyway.
    expect(worker.calls).toEqual([undefined]);
  });

  /** The four sites that warn also catch: a close that throws is the caller's to
   * report, with the name of the thing that failed. */
  it('lets the close reject on its own', async () => {
    await expect(
      closeWithin({ close: () => Promise.reject(new Error('boom')) }, 1_000),
    ).rejects.toThrow('boom');
  });

  /**
   * Without this a resource that closed at once held the loop open for the rest
   * of the bound, and a clean shutdown took 2.37 s against 0.36 s.
   *
   * Asserted against the handle rather than the clock. The timer is unref'd, so a
   * run that never cleared it would still return at the close and still finish
   * inside any elapsed-time bound - which is what the first version of this test
   * measured, and it passed with the `clearTimeout` deleted.
   */
  it('clears the timer for a close that finished in time', async () => {
    const arm = spyOn(globalThis, 'setTimeout');
    const disarm = spyOn(globalThis, 'clearTimeout');
    try {
      expect(await closeWithin(bullmqLike(true), 30_000)).toBe(false);
      expect(arm).toHaveBeenCalledTimes(1);
      expect(disarm).toHaveBeenCalledTimes(1);
      // The one it cleared is the one it armed, not some other pending timer.
      expect(arm.mock.results[0]?.value).toBe(disarm.mock.calls[0]?.[0]);
    } finally {
      arm.mockRestore();
      disarm.mockRestore();
    }
  });
});
