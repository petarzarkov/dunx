import { describe, expect, it } from 'bun:test';
import { ContextStore } from './context.js';
import { captureConsole, testConfig, testLogger } from './fixture.test.js';

/** A promise plus the function that settles it, so a flow can be suspended on cue. */
const gate = (): { promise: Promise<void>; open: () => void } => {
  let open: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

describe('ContextStore', () => {
  it('reads as empty outside any flow', () => {
    expect(new ContextStore().getContext()).toEqual({});
  });

  it('ignores an update made outside any flow', () => {
    const store = new ContextStore();

    expect(() => {
      store.updateContext({ requestId: 'nowhere' });
    }).not.toThrow();
    expect(store.getContext()).toEqual({});
  });

  it('hands out a copy, so the live context cannot be mutated through it', () => {
    const store = new ContextStore();

    store.runWithContext({ requestId: 'a' }, () => {
      const snapshot = store.getContext();
      snapshot.requestId = 'mutated';

      expect(store.getContext()).toEqual({ requestId: 'a' });
    });
  });

  it('merges an update rather than replacing the context', () => {
    const store = new ContextStore();

    store.runWithContext({ requestId: 'a' }, () => {
      store.updateContext({ userId: 'u-1' });

      expect(store.getContext()).toEqual({ requestId: 'a', userId: 'u-1' });
    });
  });

  it('returns the callback result', () => {
    expect(new ContextStore().runWithContext({}, () => 42)).toBe(42);
  });

  it('survives an await', async () => {
    const store = new ContextStore();

    const seen = await store.runWithContext(
      { requestId: 'awaited' },
      async () => {
        await Bun.sleep(1);
        await Promise.resolve();
        return store.getContext().requestId;
      },
    );

    expect(seen).toBe('awaited');
  });

  it('propagates into setTimeout', async () => {
    const store = new ContextStore();

    const seen = await new Promise<string | undefined>((resolve) => {
      store.runWithContext({ requestId: 'timer' }, () => {
        setTimeout(() => {
          resolve(store.getContext().requestId);
        }, 1);
      });
    });

    expect(seen).toBe('timer');
  });

  it('propagates into queueMicrotask', async () => {
    const store = new ContextStore();

    const seen = await new Promise<string | undefined>((resolve) => {
      store.runWithContext({ requestId: 'micro' }, () => {
        queueMicrotask(() => {
          resolve(store.getContext().requestId);
        });
      });
    });

    expect(seen).toBe('micro');
  });

  it('shadows an outer flow and restores it afterwards', () => {
    const store = new ContextStore();

    store.runWithContext({ requestId: 'outer' }, () => {
      store.runWithContext({ requestId: 'inner' }, () => {
        expect(store.getContext()).toEqual({ requestId: 'inner' });
      });

      expect(store.getContext()).toEqual({ requestId: 'outer' });
    });
  });

  /**
   * The property that is easy to get wrong: two flows that overlap in time must
   * not see each other's fields. The gates force real overlap — `a` is suspended
   * inside its own flow while `b` starts, writes to its context and finishes —
   * so a store that kept one shared object would fail on the resume line.
   */
  it('isolates two overlapping flows', async () => {
    const store = new ContextStore();
    const started = gate();
    const written = gate();
    const order: string[] = [];
    const observe = (label: string): void => {
      order.push(`${label}:${String(store.getContext().requestId)}`);
    };

    const first = store.runWithContext({ requestId: 'a' }, async () => {
      observe('a-start');
      started.open();
      await written.promise;
      observe('a-resume');
      store.updateContext({ step: 'a' });
      return store.getContext();
    });

    const second = store.runWithContext({ requestId: 'b' }, async () => {
      await started.promise;
      observe('b-start');
      store.updateContext({ step: 'b' });
      written.open();
      await Bun.sleep(1);
      observe('b-end');
      return store.getContext();
    });

    const [contextA, contextB] = await Promise.all([first, second]);

    expect(contextA).toEqual({ requestId: 'a', step: 'a' });
    expect(contextB).toEqual({ requestId: 'b', step: 'b' });
    // Every observation saw its own flow's id, and `a` really did resume after
    // `b` had run — the two were interleaved, not sequential.
    expect(order[0]).toBe('a-start:a');
    expect(order[1]).toBe('b-start:b');
    expect(order.indexOf('a-resume:a')).toBeGreaterThan(1);
    expect(order).toHaveLength(4);
  });

  it('keeps concurrent flows apart in what the logger writes', async () => {
    const store = new ContextStore();
    const logger = testLogger(testConfig, store);
    const capture = captureConsole();

    try {
      const flow = (requestId: string, delay: number): Promise<void> =>
        store.runWithContext({ requestId }, async () => {
          await Bun.sleep(delay);
          store.updateContext({ userId: `user-${requestId}` });
          await Bun.sleep(delay);
          logger.log(`from ${requestId}`);
        });

      await Promise.all([flow('one', 2), flow('two', 1), flow('three', 3)]);

      const entries = capture.lines.map((_line, index) => capture.entry(index));
      expect(entries).toHaveLength(3);
      for (const entry of entries) {
        const requestId = String(entry['requestId']);
        expect(entry['message']).toBe(`from ${requestId}`);
        expect(entry['userId']).toBe(`user-${requestId}`);
      }
      const ids = entries
        .map((entry) => String(entry['requestId']))
        .sort((left, right) => left.localeCompare(right));
      expect(ids).toEqual(['one', 'three', 'two']);
    } finally {
      capture.restore();
    }
  });

  it('writes an entry with no context fields outside any flow', () => {
    const store = new ContextStore();
    const logger = testLogger(testConfig, store);
    const capture = captureConsole();

    try {
      logger.log('no flow');

      const entry = capture.entry();
      expect(entry).toMatchObject({ message: 'no flow' });
      expect(entry).not.toHaveProperty('requestId');
    } finally {
      capture.restore();
    }
  });
});
