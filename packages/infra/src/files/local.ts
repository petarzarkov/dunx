import { resolve } from 'node:path';
import type { BunFile } from 'bun';
import { FileNotFoundError, UnsupportedOperationError } from './errors.js';
import { isMissing, resolveDirWithin, resolveWithin, toPosix } from './path.js';
import { pump } from './stream.js';
import {
  Storage,
  StorageOptions,
  type FileStat,
  type ListEntry,
  type ListOptions,
  type WriteData,
} from './storage.js';

export class LocalStorageOptions extends StorageOptions {
  /** Absolute. Every key is resolved against it and may not escape it. */
  readonly root: string;
  /** Create missing parent directories on write. */
  readonly createPath: boolean;

  constructor(root: string, createPath = true) {
    super();
    this.root = resolve(root);
    this.createPath = createPath;
  }

  create(): Storage {
    return new LocalStorage(this);
  }
}

/**
 * `Bun.file` for reads, `Bun.write` for writes, `Bun.Glob` for listings.
 *
 * Every key is resolved against the configured root and rejected if it lands
 * outside it, so a key that arrived over the wire cannot address the filesystem
 * at large.
 */
export class LocalStorage extends Storage {
  readonly #root: string;
  readonly #createPath: boolean;

  constructor(options: LocalStorageOptions) {
    super();
    this.#root = options.root;
    this.#createPath = options.createPath;
  }

  get root(): string {
    return this.#root;
  }

  #file(key: string): BunFile {
    return Bun.file(resolveWithin(this.#root, key));
  }

  async #guard<T>(key: string, read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (isMissing(error)) {
        throw new FileNotFoundError(key, { cause: error });
      }
      throw error;
    }
  }

  async read(key: string): Promise<string> {
    return this.#guard(key, () => this.#file(key).text());
  }

  async readBytes(key: string): Promise<Uint8Array> {
    return this.#guard(key, () => this.#file(key).bytes());
  }

  async readStream(key: string): Promise<ReadableStream<Uint8Array>> {
    const file = this.#file(key);
    // Bun.file().stream() is lazy - it opens on the first read, so a missing
    // file surfaces as a stream error rather than a rejection. Checked here so
    // the contract holds; the returned stream is still unread.
    if (!(await file.exists())) throw new FileNotFoundError(key);
    return file.stream();
  }

  async write(key: string, data: WriteData): Promise<number> {
    const path = resolveWithin(this.#root, key);
    if (!(data instanceof ReadableStream)) {
      return Bun.write(path, data, { createPath: this.#createPath });
    }

    // A FileSink neither creates parent directories nor truncates - it writes
    // over the existing bytes from offset 0 and leaves any tail behind. An empty
    // Bun.write does both jobs first, then the sink streams in over the top.
    await Bun.write(path, '', { createPath: this.#createPath });
    return pump(Bun.file(path).writer(), data);
  }

  async exists(key: string): Promise<boolean> {
    return this.#file(key).exists();
  }

  async delete(key: string): Promise<void> {
    try {
      await this.#file(key).delete();
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }

  async *list(options?: ListOptions): AsyncIterable<ListEntry> {
    const prefix = options?.prefix ?? '';
    const cwd = resolveDirWithin(this.#root, prefix);
    const limit = options?.limit ?? Infinity;
    const base = prefix === '' ? '' : `${toPosix(prefix).replace(/\/+$/, '')}/`;
    const glob = new Bun.Glob(options?.glob ?? '**/*');

    let yielded = 0;
    try {
      // dot: true - S3 has no notion of a hidden object, so neither does this.
      for await (const relative of glob.scan({
        cwd,
        dot: true,
        onlyFiles: true,
      })) {
        if (yielded >= limit) return;
        yielded += 1;
        yield { key: `${base}${toPosix(relative)}` };
      }
    } catch (error) {
      // An absent directory lists as empty, matching what S3 does for a prefix
      // no object uses. Anything else is a real failure.
      if (!isMissing(error)) throw error;
    }
  }

  async stat(key: string): Promise<FileStat> {
    const file = this.#file(key);
    const stats = await this.#guard(key, () => file.stat());
    return {
      key,
      size: stats.size,
      type: file.type,
      lastModified: new Date(stats.mtimeMs),
    };
  }

  presign(key: string): never {
    throw new UnsupportedOperationError(
      'presign',
      'LocalStorage',
      `Nothing signs "${key}" on a local disk. Configure S3StorageOptions, or ` +
        'serve the bytes through your own route.',
    );
  }
}
