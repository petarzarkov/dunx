/**
 * The `data:` payloads of a server-sent-events body, in order, ending when the
 * stream does or when a line reads `[DONE]`.
 *
 * Async iteration rather than `getReader()`: it acquires the reader and releases
 * it on completion, on a `break` in the consumer, and on the `[DONE]` return,
 * which is the case the manual form needed a `releaseLock()` in a `finally` for.
 *
 * Hand-rolled because Bun exposes no `EventSource` global and no SSE parser,
 * which was measured rather than assumed.
 */
export async function* sseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });

    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');

      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      yield data;
    }
  }
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
