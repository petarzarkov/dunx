import { describe, expect, it, spyOn } from 'bun:test';
import { frameComment, frameEvent } from './event.js';
import { SseStream } from './stream.js';

/** The comment every stream opens with, so Bun flushes the headers. */
const OPEN = ':\n\n';

/** Everything an `SseStream` wrote, once it has ended. */
const drain = async (response: Response): Promise<string> => response.text();

const events = async function* (
  count: number,
): AsyncGenerator<{ data: string }> {
  for (let i = 0; i < count; i += 1) yield { data: `event-${i}` };
};

describe('frameEvent', () => {
  it('frames a string payload and terminates it with a blank line', () => {
    expect(frameEvent({ data: 'hello' })).toBe('data: hello\n\n');
  });

  it('repeats the field for every line of a multi-line payload', () => {
    expect(frameEvent({ data: 'one\ntwo' })).toBe('data: one\ndata: two\n\n');
    // CRLF and a bare CR end a line for an SSE parser too.
    expect(frameEvent({ data: 'one\r\ntwo\rthree' })).toBe(
      'data: one\ndata: two\ndata: three\n\n',
    );
  });

  it('serialises anything that is not a string', () => {
    expect(frameEvent({ data: { step: 1 } })).toBe('data: {"step":1}\n\n');
    expect(frameEvent({ data: 42 })).toBe('data: 42\n\n');
  });

  it('writes event, id and retry ahead of the data', () => {
    expect(frameEvent({ data: 'x', event: 'tick', id: '7', retry: 2500 })).toBe(
      'event: tick\nid: 7\nretry: 2500\ndata: x\n\n',
    );
  });

  it('truncates retry to an integer, which is all a client parses', () => {
    expect(frameEvent({ data: 'x', retry: 2500.9 })).toContain('retry: 2500\n');
  });

  it('keeps a field to one line, so a name cannot inject another', () => {
    expect(frameEvent({ data: 'x', event: 'tick\nid: 9' })).toBe(
      'event: tick\ndata: x\n\n',
    );
  });

  it('omits data entirely when there is none, for a retry-only frame', () => {
    expect(frameEvent({ retry: 5000 })).toBe('retry: 5000\n\n');
  });
});

describe('frameComment', () => {
  it('is a bare colon, which is what a heartbeat writes', () => {
    expect(frameComment('')).toBe(':\n\n');
    expect(frameComment('keep-alive')).toBe(':keep-alive\n\n');
  });

  it('prefixes every line, so a comment cannot become a field', () => {
    expect(frameComment('a\ndata: b')).toBe(':a\n:data: b\n\n');
  });
});

describe('SseStream', () => {
  it('sets the three headers an event stream is read by', () => {
    const res = new SseStream({ heartbeatMs: 0 }).toResponse();
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect(res.headers.get('connection')).toBe('keep-alive');
  });

  it('merges extra headers under its own, which win', () => {
    const res = new SseStream({ heartbeatMs: 0 }).toResponse({
      'x-feed': 'ticks',
      'content-type': 'text/plain',
    });
    expect(res.headers.get('x-feed')).toBe('ticks');
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });

  it('writes what was sent before the body was read', async () => {
    const stream = new SseStream({ heartbeatMs: 0 });
    stream.send({ data: 'one' });
    stream.send({ data: 'two', id: '2' });
    stream.close();
    expect(await drain(stream.toResponse())).toBe(
      `${OPEN}data: one\n\nid: 2\ndata: two\n\n`,
    );
  });

  it('remembers the id of the last event that carried one', () => {
    const stream = new SseStream({ heartbeatMs: 0 });
    expect(stream.lastEventId).toBeUndefined();
    stream.send({ data: 'one', id: '1' });
    stream.send({ data: 'two' });
    expect(stream.lastEventId).toBe('1');
  });

  it('drops a send after close rather than throwing at the handler', async () => {
    const stream = new SseStream({ heartbeatMs: 0 });
    stream.send({ data: 'one' });
    stream.close();
    stream.send({ data: 'two' });
    stream.close();
    expect(stream.closed).toBe(true);
    expect(await drain(stream.toResponse())).toBe(`${OPEN}data: one\n\n`);
  });

  it('sends a comment every heartbeat, and stops at close', async () => {
    const stream = new SseStream({ heartbeatMs: 5 });
    const response = stream.toResponse();
    await Bun.sleep(30);
    stream.close();
    const written = await drain(response);
    expect(written.length).toBeGreaterThan(0);
    expect(written).toMatch(/^(:\n\n)+$/);
  });

  it('sends no heartbeat at all when the interval is zero', async () => {
    const stream = new SseStream({ heartbeatMs: 0 });
    const response = stream.toResponse();
    await Bun.sleep(30);
    stream.close();
    expect(await drain(response)).toBe(OPEN);
  });

  /**
   * Bun holds the headers until the body's first chunk, so a stream that sends
   * nothing leaves the client connecting. Measured on 1.4.2: `fetch` against a
   * stream with nothing enqueued stayed pending for the 500 ms it was given.
   */
  it('opens with a comment, so the headers reach the client', async () => {
    const stream = new SseStream({ heartbeatMs: 0 });
    const reader = stream.toResponse().body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toBe(OPEN);
    await reader.cancel();
  });

  /**
   * The leak this guards is one live `setInterval` per client that went away.
   * `cancel` is what a disconnect reaches the server as, so the assertion is that
   * the timer stops firing rather than that the stream reports itself closed.
   */
  it('clears the heartbeat when the body is cancelled', async () => {
    const stream = new SseStream({ heartbeatMs: 5 });
    const beat = spyOn(stream, 'comment');
    const response = stream.toResponse();
    await Bun.sleep(20);
    expect(beat.mock.calls.length).toBeGreaterThan(0);

    await response.body!.cancel();
    expect(stream.closed).toBe(true);

    const beats = beat.mock.calls.length;
    await Bun.sleep(40);
    expect(beat.mock.calls.length).toBe(beats);
  });

  it('clears the heartbeat on close too', async () => {
    const stream = new SseStream({ heartbeatMs: 5 });
    const beat = spyOn(stream, 'comment');
    const response = stream.toResponse();
    await Bun.sleep(20);
    stream.close();

    const beats = beat.mock.calls.length;
    await Bun.sleep(40);
    expect(beat.mock.calls.length).toBe(beats);
    await drain(response);
  });
});

describe('SseStream.from', () => {
  it('pumps an async iterable and closes when it ends', async () => {
    const stream = SseStream.from(events(3), { heartbeatMs: 0 });
    expect(await drain(stream.toResponse())).toBe(
      `${OPEN}data: event-0\n\ndata: event-1\n\ndata: event-2\n\n`,
    );
    expect(stream.closed).toBe(true);
  });

  /**
   * A throw once the headers are out cannot become a status, so the body ends
   * without its terminal chunk and the client reconnects - which is the failure
   * an `EventSource` is specified around.
   */
  it('errors the body when the iterable throws', async () => {
    const failing = async function* (): AsyncGenerator<{ data: string }> {
      yield { data: 'one' };
      throw new Error('upstream gone');
    };

    const stream = SseStream.from(failing(), { heartbeatMs: 0 });
    await expect(drain(stream.toResponse())).rejects.toThrow('upstream gone');
  });

  it('stops iterating once the client has gone', async () => {
    let produced = 0;
    const endless = async function* (): AsyncGenerator<{ data: string }> {
      for (;;) {
        produced = produced + 1;
        yield { data: `tick-${produced}` };
        await Bun.sleep(5);
      }
    };

    const stream = SseStream.from(endless(), { heartbeatMs: 0 });
    const response = stream.toResponse();
    await Bun.sleep(20);
    await response.body!.cancel();

    const seen = produced;
    await Bun.sleep(40);
    // The loop breaks on the next yield, so one more may be produced and dropped.
    expect(produced).toBeLessThanOrEqual(seen + 1);
  });
});
