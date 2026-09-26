import { describe, expect, it, spyOn } from 'bun:test';
import { within } from './within.js';

const never = new Promise<string>(() => {
  /* a close waiting on a broker that is gone */
});

describe('within', () => {
  it('hands back the value when the work settles first', async () => {
    expect(await within(Promise.resolve('done'), 1_000, () => 'late')).toBe(
      'done',
    );
  });

  it('hands back what onTimeout returns when the bound expires first', async () => {
    const started = Bun.nanoseconds();
    expect(await within(never, 20, () => 'timed out')).toBe('timed out');
    expect((Bun.nanoseconds() - started) / 1e6).toBeGreaterThanOrEqual(15);
  });

  it('rejects with what onTimeout throws', async () => {
    const expired = new Error('exceeded 5ms');
    await expect(
      within(never, 5, () => {
        throw expired;
      }),
    ).rejects.toBe(expired);
  });

  it('rejects when the work rejects', async () => {
    await expect(
      within(Promise.reject(new Error('refused')), 1_000, () => undefined),
    ).rejects.toThrow('refused');
  });

  it('does not call onTimeout when the work won', async () => {
    let called = false;
    await within(Promise.resolve(1), 5, () => (called = true));
    await Bun.sleep(15);
    expect(called).toBe(false);
  });

  /**
   * Asserted against the handle rather than the clock. The timer is unref'd, so
   * a run that never cleared it would still return at the work and pass any
   * elapsed-time bound, which is what an earlier version of this test measured.
   */
  it('clears the timer it armed for work that finished in time', async () => {
    const arm = spyOn(globalThis, 'setTimeout');
    const disarm = spyOn(globalThis, 'clearTimeout');
    try {
      await within(Promise.resolve('done'), 30_000, () => 'late');
      expect(arm).toHaveBeenCalledTimes(1);
      expect(disarm).toHaveBeenCalledTimes(1);
      expect(arm.mock.results[0]?.value).toBe(disarm.mock.calls[0]?.[0]);
    } finally {
      arm.mockRestore();
      disarm.mockRestore();
    }
  });
});
