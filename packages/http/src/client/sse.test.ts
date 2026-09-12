import { describe, expect, it } from 'bun:test';
import {
  ConnectDeadline,
  sseData,
  sseMessages,
  type SseMessage,
} from './sse.js';

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

const messages = async (
  body: ReadableStream<Uint8Array>,
): Promise<SseMessage[]> => {
  const out: SseMessage[] = [];
  for await (const message of sseMessages(body)) out.push(message);
  return out;
};

describe('sseMessages', () => {
  it('joins a CRLF split across two chunks into one event', async () => {
    const messages = [];
    for await (const m of sseMessages(
      streamOf('data: a\r', '\ndata: b\r\n\r\n'),
    )) {
      messages.push(m);
    }

    // A trailing `\r` is half of a `\r\n` until the next byte says otherwise;
    // taking it as a line ending split this into two events.
    expect(messages).toEqual([{ data: 'a\nb' }]);
  });

  it('dispatches a data field carrying an empty value', async () => {
    const messages = [];
    for await (const m of sseMessages(streamOf('data:\n\n'))) messages.push(m);

    // Only a frame with no `data:` field at all is skipped, which is what a
    // comment heartbeat relies on.
    expect(messages).toEqual([{ data: '' }]);
  });

  it('carries the envelope, not just the payload', async () => {
    expect(
      await messages(
        streamOf('event: tick\nid: 7\nretry: 2500\ndata: {"n":1}\n\n'),
      ),
    ).toEqual([{ data: '{"n":1}', event: 'tick', id: '7', retry: 2500 }]);
  });

  it('joins a multi-line payload into one event', async () => {
    expect(await messages(streamOf('data: one\ndata: two\n\n'))).toEqual([
      { data: 'one\ntwo' },
    ]);
  });

  it('dispatches nothing for a comment, which is what a heartbeat is', async () => {
    expect(
      await messages(streamOf(':\n\n: keep-alive\n\ndata: a\n\n')),
    ).toEqual([{ data: 'a' }]);
  });

  it('strips one leading space and keeps the rest', async () => {
    expect(await messages(streamOf('data:  padded\n\n'))).toEqual([
      { data: ' padded' },
    ]);
  });

  it('reads CRLF and a bare CR as line endings', async () => {
    expect(await messages(streamOf('data: a\r\n\r\ndata: b\r\r'))).toEqual([
      { data: 'a' },
      { data: 'b' },
    ]);
  });

  it('ignores a retry that is not an integer', async () => {
    expect(await messages(streamOf('retry: soon\ndata: a\n\n'))).toEqual([
      { data: 'a' },
    ]);
  });

  it('drops an event the body ended in the middle of', async () => {
    expect(await messages(streamOf('data: whole\n\ndata: partial\n'))).toEqual([
      { data: 'whole' },
    ]);
  });

  it('clears the event name between dispatches', async () => {
    expect(
      await messages(streamOf('event: named\ndata: a\n\ndata: b\n\n')),
    ).toEqual([{ data: 'a', event: 'named' }, { data: 'b' }]);
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
