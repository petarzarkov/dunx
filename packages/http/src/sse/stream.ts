import { frameComment, frameEvent, type SseEvent } from './event.js';

export interface SseStreamOptions {
  /**
   * Milliseconds between the comment lines that stop a proxy seeing no bytes
   * from reaping the connection. `0` sends none. @default 15000
   */
  readonly heartbeatMs?: number;
}

const DEFAULT_HEARTBEAT_MS = 15_000;

/** Stateless, so one serves every connection rather than one per open stream. */
const encoder = new TextEncoder();

/** Tells `Compression` and any proxy to leave the bytes alone. */
const SSE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
});

/**
 * A server-sent-events response, held open by a `ReadableStream` in a `Response`.
 * `@Sse` builds one for a handler returning an `AsyncIterable` and takes one a
 * handler built itself; outside a route it is a `Response` a `@Get` can return.
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
      // A disconnect: not tearing down leaks a heartbeat timer per lost client.
      cancel: () => {
        this.#stop();
      },
    });

    // Bun holds the headers until the body's first chunk, so one comment line
    // opens the connection. Clients ignore it. Measured on 1.4.2.
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
   * Pumps `events` into a new stream, closing it when the iterable ends. A throw
   * once the headers are out cannot become a status, so the body ends without its
   * terminal chunk and an `EventSource` reconnects.
   */
  static from(
    events: AsyncIterable<SseEvent>,
    options: SseStreamOptions = {},
  ): SseStream {
    const stream = new SseStream(options);
    void (async () => {
      try {
        for await (const event of events) {
          // Disconnected. `break` runs the generator's `return`, so a handler's
          // `finally` releases what it holds.
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
   * `headers` merge under the three this sets. No status: an event stream is a
   * 200 or it is not one. */
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
