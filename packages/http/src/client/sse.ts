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
 * `getReader()` rather than async iteration, so the last read is told apart from
 * a chunk boundary: a trailing `\r` is half a `\r\n` in one and a line ending in
 * the other. `releaseLock` in a `finally` covers a `break` and `[DONE]`.
 * Hand-rolled: Bun exposes no `EventSource` and no SSE parser, measured.
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

  const reader = body.getReader();
  let done = false;

  try {
    for (;;) {
      let end = LINE.exec(buffer);
      while (end !== null) {
        // A trailing `\r` may be half of a `\r\n` in the next chunk, and taking
        // it as a line ending splits one event in two. Once the body has ended
        // nothing more is coming, so it is one.
        if (!done && end[0] === '\r' && end.index + 1 === buffer.length) break;
        const line = buffer.slice(0, end.index);
        buffer = buffer.slice(end.index + end[0].length);
        end = LINE.exec(buffer);

        // The blank line dispatches.
        if (line === '') {
          const seen = data.length > 0;
          const payload = data.join('\n');
          data = [];
          // No `data:` field at all does not dispatch, which a heartbeat relies
          // on. One carrying an empty value does.
          if (!seen) {
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
        else if (field === 'retry' && /^\d+$/.test(value))
          retry = Number(value);
      }

      if (done) return;
      const next = await reader.read();
      if (next.done) {
        buffer += decoder.decode();
        done = true;
        continue;
      }
      buffer += decoder.decode(next.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
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
