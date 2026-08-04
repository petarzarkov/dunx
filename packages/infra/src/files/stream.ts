import type { FileSink } from 'bun';

/**
 * Drains `source` into `sink` one chunk at a time, returning the byte count.
 *
 * This exists because neither write path takes a stream. `Bun.write(path,
 * stream)` matches no overload and silently persists the string
 * `"[object ReadableStream]"`, and its `Response` overload never settles when
 * the response body is itself a stream (measured on Bun 1.3.14). A sink is also
 * the only option that keeps the promise this package makes: one chunk is
 * resident at a time, so a file larger than memory still transfers.
 *
 * `FileSink.write` returns a promise once its buffer fills, which is how
 * backpressure reaches the producer - hence the await. Its return value is a
 * buffered-bytes counter rather than a per-chunk count, so the total is taken
 * from the chunks instead.
 */
export const pump = async (
  sink: FileSink,
  source: ReadableStream<Uint8Array>,
): Promise<number> => {
  let written = 0;

  try {
    // `for await` rather than `getReader()` and a `for (;;)` reading until
    // `done`: a `ReadableStream` is async-iterable, and iterating it acquires the
    // reader and releases it on completion, `break` **and** throw - all measured.
    // The manual form was the same loop plus a `done` check and two
    // `releaseLock()` calls that had to be kept in step by hand.
    for await (const chunk of source) {
      written += chunk.byteLength;
      await sink.write(chunk);
    }
  } catch (error) {
    // Ends the sink in a failed state so a partial multipart upload is aborted
    // rather than committed.
    await sink.end(error instanceof Error ? error : undefined);
    throw error;
  }

  await sink.end();
  return written;
};
