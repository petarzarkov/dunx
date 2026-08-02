/**
 * What `write()` accepts. A `ReadableStream` is listed deliberately: it is the
 * one input neither `Bun.write` nor `S3Client.write` takes, and the backends
 * route it through a sink instead of buffering it — see stream.ts.
 */
export type WriteData =
  | string
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>;

export interface FileStat {
  readonly key: string;
  readonly size: number;
  /** MIME type. Derived from the key's extension on both backends. */
  readonly type: string;
  readonly lastModified: Date;
  /** S3 only — the local filesystem stores no entity tag. */
  readonly etag?: string | undefined;
}

/**
 * `size` and `lastModified` are present only when the backend hands them over
 * with the listing. S3 does; a glob scan does not, and statting every hit would
 * turn one listing into N syscalls. Call `stat()` when you need them.
 */
export interface ListEntry {
  readonly key: string;
  readonly size?: number | undefined;
  readonly lastModified?: Date | undefined;
}

export interface ListOptions {
  /** Restricts the listing to keys under this prefix. */
  readonly prefix?: string;
  /** Glob pattern, matched against keys relative to `prefix`. */
  readonly glob?: string;
  readonly limit?: number;
}

export interface PresignOptions {
  /** Seconds until the URL expires. */
  readonly expiresIn?: number;
  readonly method?: 'GET' | 'PUT' | 'DELETE' | 'HEAD';
  /** Content type the signature commits the upload to. */
  readonly type?: string;
}

/**
 * The one contract both backends satisfy. Inject this — never `LocalStorage` or
 * `S3Storage` — and swapping the backend is a change to one `forRoot` call.
 *
 * An abstract class, not an interface, because a dunx constructor parameter has
 * to name something that exists at runtime for `@dunx/transform` to record it.
 */
export abstract class Storage {
  abstract read(key: string): Promise<string>;

  abstract readBytes(key: string): Promise<Uint8Array>;

  /**
   * Rejects with `FileNotFoundError` if the key is missing, rather than handing
   * back a stream that fails on its first read. Costs one HEAD request on S3.
   */
  abstract readStream(key: string): Promise<ReadableStream<Uint8Array>>;

  /** @returns the number of bytes written. */
  abstract write(key: string, data: WriteData): Promise<number>;

  abstract exists(key: string): Promise<boolean>;

  /** Idempotent on both backends: deleting a missing key is not an error. */
  abstract delete(key: string): Promise<void>;

  /**
   * Async iterable rather than an array, so a bucket with a million objects is
   * paged rather than accumulated. Ordering is whatever the backend gives —
   * lexicographic on S3, filesystem order for a glob scan.
   */
  abstract list(options?: ListOptions): AsyncIterable<ListEntry>;

  abstract stat(key: string): Promise<FileStat>;

  /**
   * A URL granting temporary direct access, so a client can transfer bytes
   * without proxying them through the app.
   *
   * @throws UnsupportedOperationError on backends that cannot sign requests.
   */
  abstract presign(key: string, options?: PresignOptions): string;
}

/**
 * Configuration, and the backend it selects. `FilesModule` binds one of these
 * and asks it for the `Storage` — so adding a backend means adding a subclass
 * here, not a branch in the module.
 */
export abstract class StorageOptions {
  abstract create(): Storage;
}
