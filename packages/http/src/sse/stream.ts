import { frameComment, frameEvent, type SseEvent } from './event.js';

export interface SseStreamOptions {
  /**
   * Milliseconds between the comment lines that keep an idle connection from
   * being reaped by a proxy that sees no bytes. `0` sends none.
   *
   * @default 15000
   */
  readonly heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

/** Stateless, so one serves every connection rather than one per open stream. */
const encoder = new TextEncoder();

/**
 * `no-transform` is what tells `Compression`, and any proxy in front, to leave the
 * bytes alone: gzip emits its header and then nothing until the stream ends.
 */
const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
});

/**
 * A server-sent-events response, held open. `ReadableStream` in a `Response` is
 * what Bun serves it with: headers flush on return and each chunk reaches the
 * client as it is enqueued, and every stream opens with one comment line so those
 * headers go out before the first event does.
 *
 * `@Sse` builds one for a handler that returns an `AsyncIterable` and takes one a
 * handler builds itself. Outside a route it is a `Response` a `@Get` can return.
 */
export class SseStream {
  readonly #body: ReadableStream<Uint8Array>;
  #controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastEventId: string | undefined;
  #closed = false;

  constructor(options: SseStreamOptions = {}) {
    this.#body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.#controller = controller;
      },
      // What a client disconnect reaches the server as. The heartbeat is a timer
      // per connection, so a stream not torn down here is a leak that scales with
      // the clients that went away.
      cancel: () => {
        this.#stop();
      },
    });

    // Bun holds the response headers until the body's first chunk - measured on
    // 1.4.2, a stream with nothing enqueued left `fetch` pending indefinitely. One
    // comment line opens the connection, and every client ignores it.
    this.comment();

    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    if (heartbeatMs > 0) {
      this.#timer = setInterval(() => {
        this.comment();
      }, heartbeatMs);
      // The server holds the process open, not a connection's keep-alive.
      this.#timer.unref();
    }
  }

  /**
   * Pumps `events` into a new stream, closing it when the iterable ends.
   *
   * A throw once the headers are out cannot become a status code, so the body is
   * ended without its terminal chunk and an `EventSource` reconnects.
   */
  static from(
    events: AsyncIterable<SseEvent>,
    options: SseStreamOptions = {},
  ): SseStream {
    const stream = new SseStream(options);
    void (async () => {
      try {
        for await (const event of events) {
          // Closed by a disconnect. `break` runs the generator's own `return`, so
          // a `finally` in the handler releases what it holds.
          if (stream.#closed) break;
          stream.send(event);
        }
        stream.close();
      } catch (error) {
        stream.#fail(error);
      }
    })();
    return stream;
  }

  /** The `id` of the last event sent, or `undefined` if none carried one. */
  get lastEventId(): string | undefined {
    return this.#lastEventId;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Frames and enqueues one event. A send after the stream closed is dropped. */
  send(event: SseEvent): void {
    if (event.id !== undefined) this.#lastEventId = event.id;
    this.#write(frameEvent(event));
  }

  /** A comment line, which is what the heartbeat sends. */
  comment(text = ''): void {
    this.#write(frameComment(text));
  }

  close(): void {
    if (this.#closed) return;
    this.#stop();
    this.#controller?.close();
  }

  /**
   * `headers` are merged under the three this sets. There is no status: an event
   * stream is a 200 or it is not one.
   */
  toResponse(headers: Readonly<Record<string, string>> = {}): Response {
    return new Response(this.#body, {
      headers: { ...headers, ...SSE_HEADERS },
    });
  }

  #write(text: string): void {
    if (this.#closed) return;
    this.#controller?.enqueue(encoder.encode(text));
  }

  #fail(error: unknown): void {
    if (this.#closed) return;
    this.#stop();
    this.#controller?.error(error);
  }

  /** Closed first, so a heartbeat firing in the same turn enqueues nothing. */
  #stop(): void {
    this.#closed = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
