import { afterEach, describe, expect, it } from 'bun:test';
import { EventLoopLag, EventLoopLagOptions } from './event-loop.js';

const MS = 1_000_000;

/** A busy wait, since the point is to block the loop rather than yield it. */
const block = (ms: number): void => {
  const until = Bun.nanoseconds() + ms * MS;
  while (Bun.nanoseconds() < until) {
    /* holding the loop on purpose */
  }
};

let lag: EventLoopLag | undefined;

afterEach(() => {
  lag?.onShutdown();
  lag = undefined;
});

describe('EventLoopLag', () => {
  it('reports count alone until it is enabled', () => {
    lag = new EventLoopLag();
    expect(lag.snapshot()).toEqual({ count: 0 });
  });

  it('samples once onInit has run', async () => {
    lag = new EventLoopLag(new EventLoopLagOptions({ resolution: 10 }));
    lag.onInit();
    await Bun.sleep(60);
    expect(lag.snapshot().count).toBeGreaterThan(0);
  });

  /**
   * The measured reason `onInit` enables it rather than the first scrape doing
   * so: a block in the same event-loop turn as `enable()` is not sampled, and a
   * monitor enabled at read time reported 1.6-7.9 ms for a 300 ms stall.
   */
  it('measures a block that happens a turn after enabling', async () => {
    lag = new EventLoopLag(new EventLoopLagOptions({ resolution: 10 }));
    lag.onInit();
    await Bun.sleep(200);

    block(300);
    await Bun.sleep(50);

    expect(Number(lag.snapshot().max) / MS).toBeGreaterThan(250);
  }, 10_000);

  it('stops sampling after onShutdown, and enabling twice is one enable', async () => {
    lag = new EventLoopLag(new EventLoopLagOptions({ resolution: 10 }));
    lag.onInit();
    lag.onInit();
    await Bun.sleep(50);
    lag.onShutdown();
    lag.onShutdown();

    const settled = lag.snapshot().count;
    await Bun.sleep(50);
    expect(lag.snapshot().count).toBe(settled);
  });

  it('resets to the empty shape', async () => {
    lag = new EventLoopLag(new EventLoopLagOptions({ resolution: 10 }));
    lag.onInit();
    await Bun.sleep(50);
    lag.onShutdown();
    lag.reset();
    expect(lag.snapshot()).toEqual({ count: 0 });
  });

  it('defaults its resolution to 20ms', () => {
    expect(new EventLoopLagOptions().resolution).toBe(20);
    expect(new EventLoopLagOptions({ resolution: 5 }).resolution).toBe(5);
  });
});
