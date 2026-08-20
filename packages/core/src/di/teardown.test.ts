import { describe, expect, it } from 'bun:test';
import { AppFactory } from './app.js';
import type { OnBeforeShutdown, OnShutdown } from './lifecycle.js';
import { teardownError, teardownFailures } from './lifecycle.js';
import { Module } from './module.js';
import { provide } from './provider.js';

const order: string[] = [];

class First implements OnShutdown, OnBeforeShutdown {
  onBeforeShutdown(): void {
    order.push('first:drain');
  }
  onShutdown(): void {
    order.push('first:down');
  }
}

class Breaks implements OnShutdown, OnBeforeShutdown {
  onBeforeShutdown(): void {
    order.push('breaks:drain');
    throw new Error('drain exploded');
  }
  onShutdown(): Promise<void> {
    order.push('breaks:down');
    return Promise.reject(new Error('teardown exploded'));
  }
}

class Last implements OnShutdown, OnBeforeShutdown {
  onBeforeShutdown(): void {
    order.push('last:drain');
  }
  onShutdown(): void {
    order.push('last:down');
  }
}

/**
 * Registration order is resolution order, and `onShutdown` runs in reverse - so
 * `Last` tears down first and `First` last. The failing provider sits in between,
 * which is the only position that proves the loop did not stop at it.
 */
@Module({
  providers: [
    provide(First, { useFactory: () => new First() }),
    provide(Breaks, { useFactory: () => new Breaks() }),
    provide(Last, { useFactory: () => new Last() }),
  ],
})
class Root {}

describe('teardownError', () => {
  it('passes a lone failure through unchanged', () => {
    const only = new Error('one');
    expect(teardownError([only])).toBe(only);
  });

  it('aggregates several, keeping every original reachable', () => {
    const error = teardownError([new Error('a'), new Error('b')]);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toHaveLength(2);
    expect((error as Error).message).toContain('2 providers');
  });

  it('unwraps an aggregate so a phase does not nest one inside another', () => {
    const aggregate = teardownError([new Error('a'), new Error('b')]);
    expect(teardownFailures(aggregate)).toHaveLength(2);
    const single = new Error('lone');
    expect(teardownFailures(single)).toEqual([single]);
  });
});

describe('a teardown with a hook that throws', () => {
  it('runs every remaining hook, resolves closed, and reports the failures', async () => {
    order.length = 0;
    const app = await AppFactory.create(Root);

    let raised: unknown;
    try {
      await app.shutdown();
    } catch (error) {
      raised = error;
    }

    // Both phases ran end to end. Without the fix, `drain` rejected and `shutdown`
    // never reached a single `onShutdown`.
    expect(order).toEqual([
      'first:drain',
      'breaks:drain',
      'last:drain',
      'last:down',
      'breaks:down',
      'first:down',
    ]);

    // A promise nobody resolves is a shutdown that ends in SIGKILL.
    await expect(app.closed).resolves.toBeUndefined();

    expect(raised).toBeInstanceOf(AggregateError);
    expect(
      (raised as AggregateError).errors.map((error: Error) => error.message),
    ).toEqual(['drain exploded', 'teardown exploded']);
  });

  it('surfaces a failing drain to a caller that drains on its own', async () => {
    order.length = 0;
    const app = await AppFactory.create(Root);
    await expect(app.drain()).rejects.toThrow('drain exploded');
    // Memoized, so a second call is the same answer rather than a second run.
    await expect(app.drain()).rejects.toThrow('drain exploded');
    expect(order.filter((entry) => entry.endsWith(':drain'))).toHaveLength(3);
    await app.shutdown().catch(() => undefined);
  });

  it('still resolves closed when only onShutdown throws', async () => {
    class OnlyDown implements OnShutdown {
      onShutdown(): void {
        throw new Error('down');
      }
    }

    @Module({
      providers: [provide(OnlyDown, { useFactory: () => new OnlyDown() })],
    })
    class Small {}

    const app = await AppFactory.create(Small);
    await expect(app.shutdown()).rejects.toThrow('down');
    await expect(app.closed).resolves.toBeUndefined();
  });
});
