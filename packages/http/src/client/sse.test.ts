import { describe, expect, it } from 'bun:test';
import { ConnectDeadline, sseData } from './sse.js';

const streamOf = (...chunks: string[]): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });

const collect = async (body: ReadableStream<Uint8Array>): Promise<string[]> => {
  const out: string[] = [];
  for await (const data of sseData(body)) out.push(data);
  return out;
};

describe('sseData', () => {
  it('yields data lines and ignores everything else', async () => {
    expect(
      await collect(
        streamOf('event: ping\ndata: one\n\n: comment\ndata: two\n\n'),
      ),
    ).toEqual(['one', 'two']);
  });

  it('reassembles a payload split across chunks', async () => {
    expect(await collect(streamOf('data: he', 'llo\n\n'))).toEqual(['hello']);
  });

  it('stops at [DONE] without yielding it', async () => {
    expect(
      await collect(streamOf('data: a\n\ndata: [DONE]\n\ndata: b\n\n')),
    ).toEqual(['a']);
  });
});

describe('ConnectDeadline', () => {
  /**
   * The reason this exists rather than an `AbortSignal.timeout`: that one keeps
   * aborting once the headers are in, and cut a 600 ms stream at 200 ms.
   */
  it('stops being able to abort once cleared', async () => {
    const deadline = new ConnectDeadline(10, 'http://upstream.test/events');
    deadline.clear();
    await Bun.sleep(30);

    expect(deadline.signal.aborted).toBe(false);
  });

  it('aborts with a TimeoutError naming the target when not cleared', async () => {
    const deadline = new ConnectDeadline(5, 'http://upstream.test/events');
    await Bun.sleep(30);

    expect(deadline.signal.aborted).toBe(true);
    expect((deadline.signal.reason as Error).name).toBe('TimeoutError');
    expect((deadline.signal.reason as Error).message).toContain(
      'http://upstream.test/events',
    );
    deadline.clear();
  });

  it('never arms for a non-positive budget', async () => {
    const deadline = new ConnectDeadline(0, 'http://upstream.test/events');
    await Bun.sleep(20);

    expect(deadline.signal.aborted).toBe(false);
  });
});
