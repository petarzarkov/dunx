import { describe, expect, it } from 'bun:test';
import { AppError } from '../di/errors.js';
import { Bulkhead, BulkheadRejectedError } from './bulkhead.js';

describe('Bulkhead', () => {
  it('rejects past maxConcurrent when nothing may queue', async () => {
    const bulkhead = new Bulkhead({ maxConcurrent: 2 });
    await bulkhead.acquire();
    await bulkhead.acquire();
    const rejected = bulkhead.acquire();
    await expect(rejected).rejects.toBeInstanceOf(BulkheadRejectedError);
    await expect(rejected).rejects.toMatchObject({ status: 503 });
    expect(bulkhead.active).toBe(2);

    bulkhead.release();
    expect(bulkhead.active).toBe(1);
    await bulkhead.acquire();
    expect(bulkhead.active).toBe(2);
  });

  it('hands a released slot to waiters in arrival order', async () => {
    const bulkhead = new Bulkhead({ maxConcurrent: 1, maxQueued: 2 });
    await bulkhead.acquire();
    const order: string[] = [];
    const first = bulkhead.acquire().then(() => order.push('first'));
    const second = bulkhead.acquire().then(() => order.push('second'));
    expect(bulkhead.queued).toBe(2);
    await expect(bulkhead.acquire()).rejects.toBeInstanceOf(
      BulkheadRejectedError,
    );

    bulkhead.release();
    await first;
    // The slot moved to the waiter rather than back to the pool.
    expect(bulkhead.active).toBe(1);
    expect(bulkhead.queued).toBe(1);
    bulkhead.release();
    await second;
    expect(order).toEqual(['first', 'second']);

    bulkhead.release();
    expect(bulkhead.active).toBe(0);
  });

  it('drops a waiter whose caller gives up, with the signal reason', async () => {
    const bulkhead = new Bulkhead({ maxConcurrent: 1, maxQueued: 1 });
    await bulkhead.acquire();
    const controller = new AbortController();
    const waiting = bulkhead.acquire(controller.signal);
    controller.abort(new Error('hung up'));
    await expect(waiting).rejects.toThrow('hung up');
    expect(bulkhead.queued).toBe(0);

    // Its queue position is free again, and a release does not resolve it.
    const next = bulkhead.acquire();
    bulkhead.release();
    await next;
    expect(bulkhead.active).toBe(1);
  });

  it('never queues a caller that has already given up', async () => {
    const bulkhead = new Bulkhead({ maxConcurrent: 1, maxQueued: 1 });
    await bulkhead.acquire();
    const reason = new Error('already gone');
    await expect(bulkhead.acquire(AbortSignal.abort(reason))).rejects.toBe(
      reason,
    );
    expect(bulkhead.queued).toBe(0);
  });

  it('rejects a waiter that gets no slot within maxWaitMs', async () => {
    const bulkhead = new Bulkhead({
      maxConcurrent: 1,
      maxQueued: 1,
      maxWaitMs: 10,
    });
    await bulkhead.acquire();
    const started = Date.now();
    const waiting = bulkhead.acquire();
    await expect(waiting).rejects.toBeInstanceOf(BulkheadRejectedError);
    await expect(waiting).rejects.toThrow('within 10ms');
    expect(Date.now() - started).toBeGreaterThanOrEqual(9);
    expect(bulkhead.queued).toBe(0);
    expect(bulkhead.active).toBe(1);
  });

  /** A waiter served in time must not be rejected later by its own timer. */
  it('cancels the wait timer once a slot arrives', async () => {
    const bulkhead = new Bulkhead({
      maxConcurrent: 1,
      maxQueued: 1,
      maxWaitMs: 20,
    });
    await bulkhead.acquire();
    const waiting = bulkhead.acquire();
    bulkhead.release();
    await waiting;
    await Bun.sleep(30);
    expect(bulkhead.active).toBe(1);
    bulkhead.release();
    expect(bulkhead.active).toBe(0);
  });

  it('refuses a cap below 1, a negative queue or a wait it cannot time', () => {
    expect(() => new Bulkhead({ maxConcurrent: 0 })).toThrow(AppError);
    expect(() => new Bulkhead({ maxConcurrent: 1, maxQueued: -1 })).toThrow(
      'maxQueued',
    );
    for (const maxWaitMs of [0, Infinity, Number.NaN]) {
      expect(() => new Bulkhead({ maxConcurrent: 1, maxWaitMs })).toThrow(
        'maxWaitMs',
      );
    }
  });
});
