import type {
  NetworkSink,
  S3Client,
  S3FilePresignOptions,
  S3Options,
} from 'bun';
import { FileNotFoundError } from './errors.js';
import { guardMissing, normalizeKey, normalizePrefix } from './path.js';
import {
  Storage,
  StorageOptions,
  type FileStat,
  type ListEntry,
  type ListOptions,
  type PresignOptions,
  type WriteData,
} from './storage.js';

/** S3 returns at most this many keys per request, whatever `maxKeys` asks for. */
const PAGE_LIMIT = 1000;

export class S3StorageOptions extends StorageOptions {
  /**
   * Passed straight to `Bun.S3Client`. Anything omitted falls back to the
   * environment (`S3_BUCKET`/`AWS_BUCKET`, `AWS_ACCESS_KEY_ID`, …), which is how
   * Bun resolves credentials - this package adds no resolution of its own.
   */
  readonly client: S3Options;
  /** Prepended to every key, so one bucket can host several roots. */
  readonly prefix: string;

  constructor(client: S3Options = {}, prefix = '') {
    super();
    this.client = client;
    this.prefix = normalizePrefix(prefix);
  }

  create(): Storage {
    return new S3Storage(this);
  }
}

/**
 * `Bun.S3Client` - no `@aws-sdk`, no signing code of our own.
 *
 * Keys are relative to the configured prefix in both directions: what `write()`
 * takes is what `list()` and `stat()` give back, so moving a bucket under a
 * prefix does not ripple into call sites.
 */
/**
 * Drains `source` into `sink` one chunk at a time, returning the byte count.
 * `S3Client`'s write takes no `ReadableStream`, so an upload goes through the
 * `NetworkSink`, which multiparts it. Module-private because `LocalStorage` needs
 * none of it: `Bun.write(path, stream)` streams to disk on Bun 1.4.1.
 *
 * The await is backpressure: `NetworkSink.write` returns a promise once its
 * buffer fills, and its return is a buffered-bytes counter.
 */
const pump = async (
  sink: NetworkSink,
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
    // `end(error)` does not abort. Measured on Bun 1.4.1 against MinIO, with an
    // `Error` and with a string, at 7 bytes and at 6 MiB: every one committed
    // the bytes written so far. So this only closes the sink, and the caller
    // removes what it committed - see `S3Storage.write`.
    await sink.end(error instanceof Error ? error : new Error(String(error)));
    throw error;
  }

  await sink.end();
  return written;
};

export class S3Storage extends Storage {
  readonly #client: S3Client;
  readonly #prefix: string;

  constructor(options: S3StorageOptions) {
    super();
    this.#client = new Bun.S3Client(options.client);
    this.#prefix = options.prefix;
  }

  get prefix(): string {
    return this.#prefix;
  }

  /** Storage key to object key. */
  objectKey(key: string): string {
    return `${this.#prefix}${normalizeKey(key)}`;
  }

  /** Object key back to storage key. */
  #storageKey(objectKey: string): string {
    return objectKey.startsWith(this.#prefix)
      ? objectKey.slice(this.#prefix.length)
      : objectKey;
  }

  async read(key: string): Promise<string> {
    return guardMissing(key, () =>
      this.#client.file(this.objectKey(key)).text(),
    );
  }

  async readBytes(key: string): Promise<Uint8Array> {
    return guardMissing(key, () =>
      this.#client.file(this.objectKey(key)).bytes(),
    );
  }

  async readStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const file = this.#client.file(this.objectKey(key));
    // One HEAD, so a missing object rejects here instead of erroring mid-stream.
    // The GET has not started yet - the returned stream is still lazy.
    if (!(await file.exists())) throw new FileNotFoundError(key);
    return file.stream();
  }

  async write(key: string, data: WriteData): Promise<number> {
    const objectKey = this.objectKey(key);
    if (!(data instanceof ReadableStream)) {
      return this.#client.write(objectKey, data);
    }

    // The NetworkSink multiparts the upload, so the stream never has to be
    // buffered to learn its content length.
    try {
      return await pump(this.#client.file(objectKey).writer(), data);
    } catch (error) {
      // A failed sink leaves the bytes it already wrote as a complete object,
      // whatever is passed to `end` - so a source that died mid-stream would
      // otherwise leave a silently truncated object behind a rejected write.
      // Best effort: the original failure is what the caller needs to see.
      await this.#client.delete(objectKey).catch(() => undefined);
      throw error;
    }
  }

  async exists(key: string): Promise<boolean> {
    return this.#client.exists(this.objectKey(key));
  }

  async delete(key: string): Promise<void> {
    // DeleteObject succeeds on a key that was never there, which is the
    // idempotence the contract promises.
    await this.#client.delete(this.objectKey(key));
  }

  async *list(options?: ListOptions): AsyncIterable<ListEntry> {
    const prefix =
      options?.prefix === undefined || options.prefix === ''
        ? this.#prefix
        : `${this.#prefix}${normalizeKey(options.prefix)}`;
    // S3 has no glob, so the pattern is applied to the keys it returns. That
    // also means maxKeys cannot be derived from `limit` when a glob is in play -
    // the page would be capped before the filter ran.
    const matcher =
      options?.glob === undefined ? undefined : new Bun.Glob(options.glob);
    const limit = options?.limit ?? Infinity;

    let token: string | undefined;
    let yielded = 0;

    do {
      const page = await this.#client.list({
        prefix,
        ...(token === undefined ? {} : { continuationToken: token }),
        ...(matcher === undefined && limit !== Infinity
          ? { maxKeys: Math.min(PAGE_LIMIT, limit - yielded) }
          : {}),
      });

      for (const object of page.contents ?? []) {
        const key = this.#storageKey(object.key);
        if (matcher !== undefined && !matcher.match(key)) continue;
        if (yielded >= limit) return;
        yielded += 1;
        yield {
          key,
          size: object.size,
          lastModified:
            object.lastModified === undefined
              ? undefined
              : new Date(object.lastModified),
        };
      }

      token =
        page.isTruncated === true ? page.nextContinuationToken : undefined;
    } while (token !== undefined && yielded < limit);
  }

  async stat(key: string): Promise<FileStat> {
    const stats = await guardMissing(key, () =>
      this.#client.stat(this.objectKey(key)),
    );
    return {
      key,
      size: stats.size,
      type: stats.type,
      lastModified: stats.lastModified,
      etag: stats.etag,
    };
  }

  /**
   * Synchronous and offline - signing is HMAC over the request, so this needs
   * credentials but never the network.
   */
  presign(key: string, options?: PresignOptions): string {
    const signing: S3FilePresignOptions = {
      ...(options?.expiresIn === undefined
        ? {}
        : { expiresIn: options.expiresIn }),
      ...(options?.method === undefined ? {} : { method: options.method }),
      ...(options?.type === undefined ? {} : { type: options.type }),
    };
    return this.#client.presign(this.objectKey(key), signing);
  }
}
