import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Module } from '@dunx/core';
import { Compression } from '../compression/compression.js';
import { CompressionModule } from '../compression/module.js';
import { Controller, Get } from '../route/decorators.js';
import type { RouteSchemas } from '../route/schema.js';
import { HttpFactory, type HttpApp } from '../server/factory.js';
import { Sse, type SseInput, type SseSchemas } from './decorators.js';
import type { SseEvent } from './event.js';
import { SseStream } from './stream.js';

/** The comment every stream opens with, so Bun flushes the headers. */
const OPEN = ':\n\n';

/** Set by `/feed/endless` so a test can tell whether its generator is still going. */
const produced = { count: 0 };
/** The stream `/feed/held` handed out, so a test can watch its heartbeat. */
let held: SseStream | undefined;
/** The stream `/feed/silent` handed out, which sends nothing until a test does. */
let silent: SseStream | undefined;

@Controller('/feed')
class FeedController {
  @Sse('/ticks')
  async *ticks(_input: SseInput<RouteSchemas>): AsyncGenerator<SseEvent> {
    yield { data: { tick: 1 }, id: '1', event: 'tick' };
    yield { data: { tick: 2 }, id: '2', event: 'tick' };
  }

  /** The `Last-Event-ID` header, resumed from - the whole point of sending `id`. */
  @Sse('/resume')
  async *resume(input: SseInput<RouteSchemas>): AsyncGenerator<SseEvent> {
    const from = Number(input.lastEventId ?? '0');
    yield { data: `from ${from}`, id: String(from + 1) };
  }

  /** A stream the handler owns, rather than one the decorator builds for it. */
  @Sse('/manual')
  manual(_input: SseInput<RouteSchemas>): SseStream {
    const stream = new SseStream({ heartbeatMs: 0 });
    stream.send({ data: 'first', retry: 3000 });
    queueMicrotask(() => {
      stream.send({ data: 'second' });
      stream.close();
    });
    return stream;
  }

  @Sse('/awaited')
  async awaited(_input: SseInput<RouteSchemas>): Promise<SseStream> {
    await Bun.sleep(1);
    const stream = new SseStream({ heartbeatMs: 0 });
    stream.send({ data: 'late' });
    stream.close();
    return stream;
  }

  /** Heartbeating, and held open until the client goes away. */
  @Sse('/held')
  hold(_input: SseInput<RouteSchemas>): SseStream {
    const stream = new SseStream({ heartbeatMs: 5 });
    held = stream;
    stream.send({ data: 'open' });
    return stream;
  }

  /** No heartbeat and nothing to say, which is what an idle feed looks like. */
  @Sse('/silent')
  quiet(_input: SseInput<SseSchemas>): SseStream {
    silent = new SseStream({ heartbeatMs: 0 });
    return silent;
  }

  /**
   * The same bytes without `@Sse`, so nothing clears the request's idle timeout.
   * The control for the test below: without it, a test that passes proves only
   * that Bun did not sever anything within the window.
   */
  @Get('/raw')
  raw(): Response {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        controller.enqueue(new TextEncoder().encode(': open\n\n'));
      },
    });
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });
  }

  /** Never ends on its own: only a disconnect stops it. */
  @Sse('/endless')
  async *endless(_input: SseInput<RouteSchemas>): AsyncGenerator<SseEvent> {
    for (;;) {
      produced.count = produced.count + 1;
      yield { data: `tick-${produced.count}` };
      await Bun.sleep(5);
    }
  }
}

@Module({
  imports: [CompressionModule.forRoot()],
  controllers: [FeedController],
})
class AppModule {}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/** The first `n` frames of a response body, without waiting for it to end. */
const take = async (body: ReadableStream<Uint8Array>, n: number) => {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let frames = 0;
  while (frames < n) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    frames = text.split('\n\n').length - 1;
  }
  return { text, cancel: () => reader.cancel() };
};

describe('@Sse', () => {
  let app: HttpApp | undefined;

  afterEach(async () => {
    await app?.shutdown();
    app = undefined;
  });

  const boot = async (
    compress: boolean,
    idleTimeout?: number,
  ): Promise<string> => {
    app = await HttpFactory.create(AppModule, {
      bootLogging: false,
      requestLogging: false,
      ...(idleTimeout === undefined ? {} : { idleTimeout }),
    });
    if (compress) app.use(Compression);
    return app.listen(0);
  };

  it('answers an event stream from an async generator', async () => {
    const url = await boot(false);
    const res = await fetch(new URL('/feed/ticks', url));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(await res.text()).toBe(
      `${OPEN}event: tick\nid: 1\ndata: {"tick":1}\n\n` +
        'event: tick\nid: 2\ndata: {"tick":2}\n\n',
    );
  });

  it('surfaces Last-Event-ID to the handler', async () => {
    const url = await boot(false);
    const res = await fetch(new URL('/feed/resume', url), {
      headers: { 'last-event-id': '41' },
    });
    expect(await res.text()).toBe(`${OPEN}id: 42\ndata: from 41\n\n`);

    const fresh = await fetch(new URL('/feed/resume', url));
    expect(await fresh.text()).toBe(`${OPEN}id: 1\ndata: from 0\n\n`);
  });

  it('takes a stream the handler built, and one it awaited', async () => {
    const url = await boot(false);
    const manual = await fetch(new URL('/feed/manual', url));
    expect(await manual.text()).toBe(
      `${OPEN}retry: 3000\ndata: first\n\ndata: second\n\n`,
    );

    const awaited = await fetch(new URL('/feed/awaited', url));
    expect(await awaited.text()).toBe(`${OPEN}data: late\n\n`);
  });

  /**
   * `Bun.serve` flushes the headers on return and each chunk as it is enqueued,
   * so a frame is readable long before the stream ends. Without it every
   * assertion above would still pass against a response held to the last byte.
   */
  it('reaches the client a frame at a time', async () => {
    const url = await boot(false);
    const res = await fetch(new URL('/feed/endless', url));
    expect(res.headers.get('transfer-encoding')).toBe('chunked');

    const first = await take(res.body!, 2);
    expect(first.text).toBe(`${OPEN}data: tick-1\n\n`);
    await first.cancel();
  });

  /**
   * The compression bug this shipped with: `text/event-stream` matched the
   * `text/` prefix, so the middleware read the body to size it and an event
   * stream never reaches `done`. One frame took five seconds to arrive.
   */
  it('survives app.use(Compression)', async () => {
    const url = await boot(true);
    const res = await fetch(new URL('/feed/endless', url), {
      headers: { 'accept-encoding': 'gzip, zstd' },
    });
    expect(res.headers.get('content-encoding')).toBeNull();

    const first = await take(res.body!, 2);
    expect(first.text).toMatch(/^:\n\ndata: tick-\d+\n\n$/);
    await first.cancel();
  });

  /**
   * `Bun.serve` severs a request idle for `idleTimeout` seconds, a response
   * already streaming included, so a feed with nothing to say was dropped and the
   * next `enqueue` threw `Invalid state: Controller is already closed`. The
   * default is 10 s, longer than this suite should sleep for, so the server is
   * bound with 1 and both connections idle for 2.5.
   *
   * `/feed/raw` is the control: the same bytes from a plain `@Get`, where nothing
   * cleared the timeout. Without it a pass would only mean Bun severed nothing.
   */
  it('outlives the server idle timeout, where a plain route does not', async () => {
    const url = await boot(false, 1);

    /** Whether a body is still open after idling past the server's timeout. */
    const watch = async (path: string): Promise<'alive' | 'severed'> => {
      const response = await fetch(new URL(path, url));
      const reader = response.body!.getReader();
      expect(text((await reader.read()).value!)).toContain(':');
      // Issued before the window, so a sever lands on a read that is waiting.
      // 5 s rather than the 1 s configured: Bun reaps in its own sweep, and a
      // 1 s idle timeout measured 4.0 s from the last byte to the closed socket.
      const outcome = await Promise.race([
        reader
          .read()
          .then(() => 'severed' as const)
          .catch(() => 'severed' as const),
        Bun.sleep(5_000).then(() => 'alive' as const),
      ]);
      await reader.cancel().catch(() => undefined);
      return outcome;
    };

    const [stream, plain] = await Promise.all([
      watch('/feed/silent'),
      watch('/feed/raw'),
    ]);
    expect(stream).toBe('alive');
    expect(plain).toBe('severed');
  }, 15_000);

  /**
   * One live `setInterval` per client that went away is the leak. The request's
   * own abort is what reaches the decorator; the assertion is that the timer
   * stops firing, not that the stream reports itself closed.
   */
  it('clears the heartbeat when the request is aborted', async () => {
    const url = await boot(false);
    const controller = new AbortController();
    const res = await fetch(new URL('/feed/held', url), {
      signal: controller.signal,
    });
    await take(res.body!, 1);

    const stream = held!;
    const beat = spyOn(stream, 'comment');
    await Bun.sleep(25);
    expect(beat.mock.calls.length).toBeGreaterThan(0);

    controller.abort();
    await Bun.sleep(20);
    expect(stream.closed).toBe(true);

    const beats = beat.mock.calls.length;
    await Bun.sleep(40);
    expect(beat.mock.calls.length).toBe(beats);
  });

  it('stops the handler when the client disconnects', async () => {
    const url = await boot(false);
    const controller = new AbortController();
    const res = await fetch(new URL('/feed/endless', url), {
      signal: controller.signal,
    });
    await take(res.body!, 1);
    controller.abort();

    await Bun.sleep(20);
    const seen = produced.count;
    await Bun.sleep(40);
    expect(produced.count).toBeLessThanOrEqual(seen + 1);
  });
});
