import { describe, expect, it } from 'bun:test';
import type { SocketContext, SocketFrame, SocketNext } from './middleware.js';
import { SocketObserver } from './observer.js';

interface Settled {
  readonly error: unknown;
  readonly value: unknown;
  readonly event: string | undefined;
  readonly data: unknown;
}

class Recorder extends SocketObserver {
  override readonly reportsErrors = true;
  readonly seen: Settled[] = [];

  protected override settled(
    error: unknown,
    value: unknown,
    frame: SocketFrame,
    ctx: SocketContext,
  ): void {
    this.seen.push({ error, value, event: ctx.event, data: frame.data });
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
      { error: undefined, value: 'pong', event: 'echo', data: 'hi' },
    ]);
  });

  it('reports a rejection and still rejects', async () => {
    const recorder = new Recorder();
    const boom = new Error('boom');

    await expect(
      run(recorder, () => Promise.reject(boom)) as Promise<unknown>,
    ).rejects.toThrow('boom');

    expect(recorder.seen[0]?.error).toBe(boom);
    expect(recorder.seen[0]?.value).toBeUndefined();
  });

  it('reports a resolution and passes the value through', async () => {
    const recorder = new Recorder();
    const result = await (run(recorder, () =>
      Promise.resolve(42),
    ) as Promise<unknown>);

    expect(result).toBe(42);
    expect(recorder.seen[0]).toEqual({
      error: undefined,
      value: 42,
      event: 'echo',
      data: 'hi',
    });
  });

  it('reports a synchronous throw and still throws', () => {
    const recorder = new Recorder();
    const boom = new Error('sync');

    expect(() =>
      run(recorder, () => {
        throw boom;
      }),
    ).toThrow('sync');

    expect(recorder.seen[0]?.error).toBe(boom);
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
