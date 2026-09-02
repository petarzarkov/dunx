import { describe, expect, it } from 'bun:test';
import { AsyncRequestContext } from './context.js';

/**
 * The default binding for `RequestContext`, and therefore what carries `traceId`
 * in any app that has not imported a logging module. `@dunx/http`'s request
 * logging opens a scope per request and every entry a handler writes inside it is
 * expected to inherit those fields, so the merge and isolation rules here are load
 * bearing rather than incidental.
 */
describe('AsyncRequestContext', () => {
  it('reads as empty outside any scope', () => {
    expect(new AsyncRequestContext().getContext()).toEqual({});
  });

  it('exposes the fields of the enclosing scope', () => {
    const context = new AsyncRequestContext();

    const seen = context.runWithContext({ traceId: 'r1' }, () =>
      context.getContext(),
    );

    expect(seen).toEqual({ traceId: 'r1' });
    // And the scope closes: nothing leaks to the caller.
    expect(context.getContext()).toEqual({});
  });

  it('hands back a copy, so a mutation cannot reach the store', () => {
    const context = new AsyncRequestContext();

    context.runWithContext({ traceId: 'r1' }, () => {
      const first = context.getContext();
      first['traceId'] = 'tampered';
      expect(context.getContext()['traceId']).toBe('r1');
    });
  });

  /*
   * The outermost scope of a request has no enclosing store, so it takes the
   * one-spread path rather than merging with `undefined`. The copy is what that
   * path exists to keep: without it the store would be the caller's own object and
   * an `updateContext` inside would reach back out.
   */
  it('copies the fields even with no enclosing scope to merge', () => {
    const context = new AsyncRequestContext();
    const fields = { traceId: 'r1' };

    context.runWithContext(fields, () => {
      context.updateContext({ userId: 'u1' });
      expect(context.getContext()).toEqual({ traceId: 'r1', userId: 'u1' });
    });

    expect(fields).toEqual({ traceId: 'r1' });
  });

  it('merges a nested scope over the outer one', () => {
    const context = new AsyncRequestContext();

    context.runWithContext({ traceId: 'r1', flow: 'http' }, () => {
      context.runWithContext({ userId: 'u1', flow: 'job' }, () => {
        expect(context.getContext()).toEqual({
          traceId: 'r1',
          userId: 'u1',
          flow: 'job',
        });
      });

      // The merge produced a fresh object, so the inner scope did not leak out.
      expect(context.getContext()).toEqual({ traceId: 'r1', flow: 'http' });
    });
  });

  it('starts clean when inheritance is refused', () => {
    const context = new AsyncRequestContext();

    context.runWithContext({ traceId: 'r1' }, () => {
      context.runWithContext(
        { jobId: 'j1' },
        () => {
          // A detached background job must not be filed under the request that
          // happened to spawn it.
          expect(context.getContext()).toEqual({ jobId: 'j1' });
        },
        { inherit: false },
      );
    });
  });

  it('adds fields to the live scope with updateContext', () => {
    const context = new AsyncRequestContext();

    context.runWithContext({ traceId: 'r1' }, () => {
      context.updateContext({ userId: 'u1' });
      expect(context.getContext()).toEqual({ traceId: 'r1', userId: 'u1' });
    });
  });

  it('ignores updateContext outside a scope rather than throwing', () => {
    const context = new AsyncRequestContext();

    // A service that logs during boot has no request to attribute it to. That is
    // not an error, and it must not become one.
    expect(() => context.updateContext({ userId: 'u1' })).not.toThrow();
    expect(context.getContext()).toEqual({});
  });

  it('keeps an updateContext inside a nested scope out of the outer one', () => {
    const context = new AsyncRequestContext();

    context.runWithContext({ traceId: 'r1' }, () => {
      context.runWithContext({}, () => {
        context.updateContext({ userId: 'u1' });
      });
      expect(context.getContext()['userId']).toBeUndefined();
    });
  });

  it('keeps concurrent async flows apart', async () => {
    const context = new AsyncRequestContext();

    const flow = async (id: string, delay: number): Promise<string> =>
      context.runWithContext({ traceId: id }, async () => {
        await Bun.sleep(delay);
        // Interleaved on purpose: the later-starting flow finishes first.
        return String(context.getContext()['traceId']);
      });

    expect(await Promise.all([flow('a', 8), flow('b', 1)])).toEqual(['a', 'b']);
  });

  it('propagates across an await inside the scope', async () => {
    const context = new AsyncRequestContext();

    await context.runWithContext({ traceId: 'r1' }, async () => {
      await Bun.sleep(2);
      expect(context.getContext()['traceId']).toBe('r1');
      await Promise.resolve();
      expect(context.getContext()['traceId']).toBe('r1');
    });
  });

  it('is per-instance, not per-process', () => {
    const first = new AsyncRequestContext();
    const second = new AsyncRequestContext();

    first.runWithContext({ traceId: 'r1' }, () => {
      // Two apps booted in one process each get their own unless handed the same
      // instance. The container makes that one binding, so they share it.
      expect(second.getContext()).toEqual({});
    });
  });

  it('returns whatever the callback returns', () => {
    const context = new AsyncRequestContext();
    expect(context.runWithContext({}, () => 42)).toBe(42);
  });
});
