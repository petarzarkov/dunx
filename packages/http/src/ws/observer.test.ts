import { describe, expect, it, spyOn } from 'bun:test';
import type { SocketContext, SocketFrame, SocketNext } from './middleware.js';
import { SocketObserver, type SocketOutcome } from './observer.js';

interface Settled {
  readonly outcome: SocketOutcome;
  readonly event: string | undefined;
  readonly data: unknown;
}

class Recorder extends SocketObserver {
  override readonly reportsErrors = true;
  readonly seen: Settled[] = [];

  protected override settled(
    outcome: SocketOutcome,
    frame: SocketFrame,
    ctx: SocketContext,
  ): void {
    this.seen.push({ outcome, event: ctx.event, data: frame.data });
  }
}

const ctx: SocketContext = {
  gateway: 'Chat',
  path: '/ws',
  kind: 'message',
  event: 'echo',
};

const frame = { socket: {}, data: 'hi' } as unknown as SocketFrame;

const run = (observer: SocketObserver, next: SocketNext): unknown =>
  observer.handle(frame, ctx, next);

describe('SocketObserver', () => {
  it('reports a synchronous return and passes the value through', () => {
    const recorder = new Recorder();
    expect(run(recorder, () => 'pong')).toBe('pong');
    expect(recorder.seen).toEqual([
      { outcome: { ok: true, value: 'pong' }, event: 'echo', data: 'hi' },
    ]);
  });

  it('reports a rejection and still rejects', async () => {
    const recorder = new Recorder();
    const boom = new Error('boom');

    await expect(
      run(recorder, () => Promise.reject(boom)) as Promise<unknown>,
    ).rejects.toThrow('boom');

    expect(recorder.seen[0]?.outcome).toEqual({ ok: false, error: boom });
  });

  it('reports a resolution and passes the value through', async () => {
    const recorder = new Recorder();
    const result = await (run(recorder, () =>
      Promise.resolve(42),
    ) as Promise<unknown>);

    expect(result).toBe(42);
    expect(recorder.seen[0]?.outcome).toEqual({ ok: true, value: 42 });
  });

  it('reports a synchronous throw and still throws', () => {
    const recorder = new Recorder();
    const boom = new Error('sync');

    expect(() =>
      run(recorder, () => {
        throw boom;
      }),
    ).toThrow('sync');

    expect(recorder.seen[0]?.outcome).toEqual({ ok: false, error: boom });
  });

  /** Why the outcome is a union: the error alone cannot separate these two. */
  it('separates a handler that threw undefined from one that returned it', () => {
    const returned = new Recorder();
    run(returned, () => undefined);
    expect(returned.seen[0]?.outcome).toEqual({ ok: true, value: undefined });

    const threw = new Recorder();
    expect(() =>
      run(threw, () => {
        throw undefined;
      }),
    ).toThrow();
    expect(threw.seen[0]?.outcome).toEqual({ ok: false, error: undefined });
  });

  it('separates a rejection with undefined from a resolution with it', async () => {
    const rejected = new Recorder();
    await expect(
      run(rejected, () => Promise.reject(undefined)) as Promise<unknown>,
    ).rejects.toBeUndefined();

    expect(rejected.seen[0]?.outcome).toEqual({ ok: false, error: undefined });
  });

  /** An observer cannot turn a success into a failure, nor replace an error. */
  it('contains a settled that throws, on both channels', async () => {
    class Broken extends SocketObserver {
      protected override settled(): void {
        throw new Error('observer');
      }
    }

    const reported = spyOn(console, 'error').mockImplementation(
      () => undefined,
    );
    try {
      expect(run(new Broken(), () => 'pong')).toBe('pong');

      await expect(
        run(new Broken(), () =>
          Promise.reject(new Error('handler')),
        ) as Promise<unknown>,
      ).rejects.toThrow('handler');

      expect(reported).toHaveBeenCalledTimes(2);
    } finally {
      reported.mockRestore();
    }
  });

  it('defaults reportsErrors to false, so a subclass has to claim it', () => {
    class Quiet extends SocketObserver {
      seen = 0;

      protected override settled(): void {
        this.seen += 1;
      }
    }

    expect(new Quiet().reportsErrors).toBe(false);
    expect(new Recorder().reportsErrors).toBe(true);
  });
});
