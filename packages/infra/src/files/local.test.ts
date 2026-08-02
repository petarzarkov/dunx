import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import {
  FileNotFoundError,
  PathTraversalError,
  UnsupportedOperationError,
} from './errors.js';
import { LocalStorage, LocalStorageOptions } from './local.js';
import type { ListEntry } from './storage.js';

// Outside the repo tree, unique per run, removed in afterEach. Bun.$ so the
// cleanup needs no node:fs either.
const tempRoot = (): string =>
  join(Bun.env['TMPDIR'] ?? '/tmp', `dunx-files-${crypto.randomUUID()}`);

const collect = async (
  entries: AsyncIterable<ListEntry>,
): Promise<readonly string[]> => {
  const keys: string[] = [];
  for await (const entry of entries) keys.push(entry.key);
  return keys.sort();
};

/**
 * bun:test's `.rejects` chain is not typed as thenable, so the rejection is
 * captured by hand - the same approach core's own tests take.
 */
const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (reason: unknown) => reason,
  );

const streamOf = (...chunks: readonly string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  const queue = [...chunks];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(encoder.encode(next));
    },
  });
};

const drain = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of stream)
    text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
};

describe('LocalStorage', () => {
  let root: string;
  let storage: LocalStorage;

  beforeEach(() => {
    root = tempRoot();
    storage = new LocalStorage(new LocalStorageOptions(root));
  });

  afterEach(async () => {
    await Bun.$`rm -rf ${root}`.quiet();
  });

  it('resolves the root to an absolute path', () => {
    expect(new LocalStorageOptions('.').root.startsWith('/')).toBe(true);
    expect(storage.root).toBe(root);
  });

  it('round-trips text through a key that needs new directories', async () => {
    const bytes = await storage.write('reports/2024/q1.txt', 'revenue up');

    expect(bytes).toBe(10);
    expect(await storage.read('reports/2024/q1.txt')).toBe('revenue up');
    expect(await storage.exists('reports/2024/q1.txt')).toBe(true);
  });

  it('round-trips bytes, a Blob and an ArrayBuffer', async () => {
    await storage.write('raw.bin', new Uint8Array([1, 2, 3]));
    expect(await storage.readBytes('raw.bin')).toEqual(
      new Uint8Array([1, 2, 3]),
    );

    await storage.write('blob.txt', new Blob(['from a blob']));
    expect(await storage.read('blob.txt')).toBe('from a blob');

    await storage.write('buffer.bin', new Uint8Array([9, 8]).buffer);
    expect(await storage.readBytes('buffer.bin')).toEqual(
      new Uint8Array([9, 8]),
    );
  });

  it('overwrites rather than patching the leading bytes', async () => {
    await storage.write('notes.txt', 'a very long original value');
    await storage.write('notes.txt', 'short');

    expect(await storage.read('notes.txt')).toBe('short');
  });

  it('writes a ReadableStream without buffering it', async () => {
    const bytes = await storage.write(
      'stream.txt',
      streamOf('one ', 'two ', 'three'),
    );

    expect(bytes).toBe(13);
    expect(await storage.read('stream.txt')).toBe('one two three');
  });

  it('truncates when a stream replaces longer contents', async () => {
    await storage.write('stream.txt', 'X'.repeat(500));
    await storage.write('stream.txt', streamOf('tiny'));

    expect(await storage.read('stream.txt')).toBe('tiny');
    expect((await storage.stat('stream.txt')).size).toBe(4);
  });

  it('streams a multi-megabyte write through in chunks', async () => {
    const chunk = 'y'.repeat(64 * 1024);
    const chunks = Array.from({ length: 32 }, () => chunk);

    const bytes = await storage.write('big/blob.bin', streamOf(...chunks));

    expect(bytes).toBe(2 * 1024 * 1024);
    expect((await storage.stat('big/blob.bin')).size).toBe(2 * 1024 * 1024);
  });

  it('reads back as a stream', async () => {
    await storage.write('song.txt', 'la '.repeat(1000));

    const stream = await storage.readStream('song.txt');

    expect(await drain(stream)).toBe('la '.repeat(1000));
  });

  it('reports the failing chunk instead of leaving a half-written file', async () => {
    const failing = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('upstream died'));
      },
    });

    const error = await rejection(storage.write('doomed.txt', failing));

    expect((error as Error).message).toContain('upstream died');
  });

  it('stats size, type and mtime', async () => {
    const before = Date.now() - 1000;
    await storage.write('page.json', '{"a":1}');

    const stat = await storage.stat('page.json');

    expect(stat.key).toBe('page.json');
    expect(stat.size).toBe(7);
    expect(stat.type).toContain('application/json');
    expect(stat.lastModified.getTime()).toBeGreaterThan(before);
    expect(stat.etag).toBeUndefined();
  });

  it('deletes, and deleting again is not an error', async () => {
    await storage.write('temp.txt', 'bye');

    await storage.delete('temp.txt');
    expect(await storage.exists('temp.txt')).toBe(false);

    await storage.delete('temp.txt');
    await storage.delete('never/existed.txt');
  });

  it('reports a missing key the same way for every read', async () => {
    expect(await storage.exists('ghost.txt')).toBe(false);
    expect(await rejection(storage.read('ghost.txt'))).toBeInstanceOf(
      FileNotFoundError,
    );
    expect(await rejection(storage.readBytes('ghost.txt'))).toBeInstanceOf(
      FileNotFoundError,
    );
    expect(await rejection(storage.stat('ghost.txt'))).toBeInstanceOf(
      FileNotFoundError,
    );
    // Rejects up front rather than handing back a stream that fails on read.
    expect(await rejection(storage.readStream('ghost.txt'))).toBeInstanceOf(
      FileNotFoundError,
    );
  });

  it('keeps the offending key on the error', async () => {
    const error = await rejection(storage.read('missing/deep.txt'));

    expect(error).toBeInstanceOf(FileNotFoundError);
    expect((error as FileNotFoundError).key).toBe('missing/deep.txt');
  });

  describe('list', () => {
    beforeEach(async () => {
      await storage.write('top.md', 'top');
      await storage.write('reports/a.csv', 'a');
      await storage.write('reports/b.csv', 'b');
      await storage.write('reports/2024/q1.csv', 'q1');
      await storage.write('reports/notes.txt', 'n');
      await storage.write('.hidden', 'h');
    });

    it('walks the whole root recursively, dotfiles included', async () => {
      expect(await collect(storage.list())).toEqual([
        '.hidden',
        'reports/2024/q1.csv',
        'reports/a.csv',
        'reports/b.csv',
        'reports/notes.txt',
        'top.md',
      ]);
    });

    it('scopes to a prefix and still returns root-relative keys', async () => {
      expect(await collect(storage.list({ prefix: 'reports' }))).toEqual([
        'reports/2024/q1.csv',
        'reports/a.csv',
        'reports/b.csv',
        'reports/notes.txt',
      ]);
    });

    it('accepts a trailing slash on the prefix', async () => {
      expect(await collect(storage.list({ prefix: 'reports/' }))).toEqual([
        'reports/2024/q1.csv',
        'reports/a.csv',
        'reports/b.csv',
        'reports/notes.txt',
      ]);
    });

    it('filters by glob, relative to the prefix', async () => {
      expect(
        await collect(storage.list({ prefix: 'reports', glob: '*.csv' })),
      ).toEqual(['reports/a.csv', 'reports/b.csv']);

      expect(await collect(storage.list({ glob: '**/*.csv' }))).toEqual([
        'reports/2024/q1.csv',
        'reports/a.csv',
        'reports/b.csv',
      ]);
    });

    it('stops at the limit', async () => {
      expect((await collect(storage.list({ limit: 2 }))).length).toBe(2);
      expect((await collect(storage.list({ limit: 0 }))).length).toBe(0);
    });

    it('lists a prefix that does not exist as empty', async () => {
      expect(await collect(storage.list({ prefix: 'nowhere' }))).toEqual([]);
    });

    it('leaves size and lastModified unset - a glob scan does not stat', async () => {
      for await (const entry of storage.list({ glob: 'top.md' })) {
        expect(entry.size).toBeUndefined();
        expect(entry.lastModified).toBeUndefined();
      }
    });
  });

  describe('path traversal', () => {
    const escapes = [
      '../../etc/passwd',
      '..',
      '../outside.txt',
      'reports/../../outside.txt',
      '/etc/passwd',
      '..\\..\\windows',
      '',
    ];

    it('rejects every escape on read', async () => {
      for (const key of escapes) {
        expect(await rejection(storage.read(key))).toBeInstanceOf(
          PathTraversalError,
        );
      }
    });

    it('rejects every escape on write, and writes nothing', async () => {
      for (const key of escapes) {
        expect(await rejection(storage.write(key, 'pwned'))).toBeInstanceOf(
          PathTraversalError,
        );
      }
      expect(await Bun.file('/tmp/outside.txt').exists()).toBe(false);
    });

    it('rejects escapes on every other entry point too', async () => {
      const attempts = [
        storage.exists('../x'),
        storage.delete('../x'),
        storage.stat('../x'),
        storage.readBytes('../x'),
        storage.readStream('../x'),
        collect(storage.list({ prefix: '../..' })),
      ];

      for (const attempt of attempts) {
        expect(await rejection(attempt)).toBeInstanceOf(PathTraversalError);
      }
    });

    it('names the key and the root it refused to leave', async () => {
      const error = await rejection(storage.read('../../etc/passwd'));

      expect(error).toBeInstanceOf(PathTraversalError);
      expect((error as PathTraversalError).root).toBe(root);
      expect((error as Error).message).toContain('escapes the storage root');
    });

    it('allows an inner path that merely mentions dots', async () => {
      await storage.write('a..b/c.txt', 'fine');

      expect(await storage.read('a..b/c.txt')).toBe('fine');
    });
  });

  it('refuses to create directories when createPath is off', async () => {
    const strict = new LocalStorage(new LocalStorageOptions(root, false));

    expect(
      await rejection(strict.write('no/such/dir.txt', 'x')),
    ).toBeInstanceOf(Error);
  });

  it('cannot presign, and says why', async () => {
    expect(() => storage.presign('report.pdf')).toThrow(
      UnsupportedOperationError,
    );
    expect(() => storage.presign('report.pdf')).toThrow(
      /LocalStorage does not support presign\(\)/,
    );
    expect(() => storage.presign('report.pdf')).toThrow(/report\.pdf/);
  });
});
