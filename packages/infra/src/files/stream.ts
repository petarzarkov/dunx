import type { FileSink } from 'bun';

/**
 * Drains `source` into `sink` one chunk at a time, returning the byte count.
 * `S3Client`'s write takes a `Request`, `Response`, `Blob` or `BunFile` and no
 * `ReadableStream`, so the upload goes through the `NetworkSink`, which
 * multiparts it - the stream never has to be buffered to learn its length.
 * `LocalStorage` needs none of this: `Bun.write(path, stream)` streams to disk
 * on Bun 1.4.1.
 *
 * The await is backpressure: `NetworkSink.write` returns a promise once its
 * buffer fills. Its return is a buffered-bytes counter, so the total comes from
 * chunks.
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
