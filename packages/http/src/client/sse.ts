/** One dispatched event as it arrived. Not `SseEvent`, the write side, where
 * `data` is any value rather than the text off the wire. */
export interface SseMessage {
  /** The `data:` lines of one event, joined with `\n` as the spec requires. */
  readonly data: string;
  /** The `event:` name, absent for the default `message`. */
  readonly event?: string;
  readonly id?: string;
  /** The reconnection delay the server asked for, in milliseconds. */
  readonly retry?: number;
}

/** A line ends at `\r\n`, `\n` or a bare `\r`. */
const LINE = /\r\n|\r|\n/;

/** `field: value`, with one optional leading space stripped from the value. */
const split = (line: string): readonly [string, string] => {
  const colon = line.indexOf(':');
  if (colon === -1) return [line, ''];
  const value = line.slice(colon + 1);
  return [line.slice(0, colon), value.startsWith(' ') ? value.slice(1) : value];
};

/**
 * Every event of a server-sent-events body, in order, ending with the stream or
 * with `[DONE]`. One still being read when the body ends is dropped, per spec.
 *
 * Async iteration rather than `getReader()`, which releases the reader on
 * completion, on a consumer `break` and on the `[DONE]` return. Hand-rolled:
 * Bun exposes no `EventSource` global and no SSE parser, measured not assumed.
 */
export async function* sseMessages(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buffer = '';
  let data: string[] = [];
  let event: string | undefined;
  let id: string | undefined;
  let retry: number | undefined;

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    let end = LINE.exec(buffer);
    while (end !== null) {
      const line = buffer.slice(0, end.index);
      buffer = buffer.slice(end.index + end[0].length);
      end = LINE.exec(buffer);

      // The blank line dispatches. An event with no data is not one: the spec
      // resets the buffers and moves on, which is what a heartbeat relies on.
      if (line === '') {
        const payload = data.join('\n');
        data = [];
        if (payload === '') {
          event = undefined;
          continue;
        }
        if (payload === '[DONE]') return;
        yield {
          data: payload,
          ...(event === undefined ? {} : { event }),
          ...(id === undefined ? {} : { id }),
          ...(retry === undefined ? {} : { retry }),
        };
        event = undefined;
        continue;
      }

      // A comment, which is what a heartbeat is.
      if (line.startsWith(':')) continue;

      const [field, value] = split(line);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
      // The spec ignores an id containing NUL, and a non-integer retry.
      else if (field === 'id' && !value.includes('\0')) id = value;
      else if (field === 'retry' && /^\d+$/.test(value)) retry = Number(value);
    }
  }
}

/**
 * The `data:` payloads alone, one string per event rather than per line, so a
 * multi-line payload arrives as it was sent.
 */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  for await (const message of sseMessages(body)) yield message.data;
}

/**
 * A deadline on the connect alone.
 *
 * An `AbortSignal.timeout` handed to `fetch` keeps aborting after the headers
 * arrive, which cut a 600 ms stream at 200 ms when the policy supplied one. This
 * holds its timer so the caller can drop it the moment `fetch` resolves, leaving
 * the body cancellable only by the caller's own signal.
 */
export class ConnectDeadline {
  readonly #controller = new AbortController();
  readonly #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(ms: number, target: string) {
    this.#timer =
      ms > 0
        ? setTimeout(() => {
            this.#controller.abort(
              new DOMException(
                `Connecting to ${target} timed out after ${ms}ms`,
                'TimeoutError',
              ),
            );
          }, ms)
        : undefined;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  clear(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
  }
}
