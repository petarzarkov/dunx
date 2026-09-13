import { describe, expect, it } from 'bun:test';
import { withTimeout } from './with-timeout.js';

/** Shared by `@dunx/infra/queue`'s `jobTimeoutMs` and `@dunx/infra/amqp`'s
 * `handlerTimeoutMs`, which had written the same race twice. */
describe('withTimeout', () => {
  it('returns what finished in time', async () => {
    expect(
      await withTimeout(
        () => 'done',
        1_000,
        () => new Error('late'),
      ),
    ).toBe('done');
  });

  it('awaits a promise the work returned', async () => {
    const value = await withTimeout(
      async () => {
        await Bun.sleep(1);
        return 42;
      },
      1_000,
      () => new Error('late'),
    );
    expect(value).toBe(42);
  });

  it('rejects with the error the caller builds', async () => {
    const expired = new Error('exceeded 5ms');
    await expect(
      withTimeout(
        () => Bun.sleep(1_000),
        5,
        () => expired,
      ),
    ).rejects.toBe(expired);
  });

  it('lets the work reject on its own', async () => {
    await expect(
      withTimeout(
        () => Promise.reject(new Error('boom')),
        1_000,
        () => new Error('late'),
      ),
    ).rejects.toThrow('boom');
  });

  /** Otherwise work that finished in time leaves a pending timer, and the
   * process cannot exit until the longest one fires. */
  it('clears the timer for work that finished in time', async () => {
    const started = Bun.nanoseconds();
    await withTimeout(
      () => 'done',
      30_000,
      () => new Error('late'),
    );
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(500);
  });
});
