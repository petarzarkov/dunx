import { AppFactory, Module, provide } from '@dunx/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { LocalStorage, LocalStorageOptions } from './local.js';
import { FilesModule } from './module.js';
import { S3Storage, S3StorageOptions } from './s3.js';
import { Storage, StorageOptions } from './storage.js';

const tempRoot = (): string =>
  join(Bun.env['TMPDIR'] ?? '/tmp', `dunx-files-${crypto.randomUUID()}`);

/**
 * A consumer with constructor injection. `bun test` runs from source with no
 * `@dunx/transform` preload, so the dependency record the plugin would have
 * appended is written by hand - exactly as core's own dynamic-module test does.
 */
class Uploads {
  constructor(private readonly storage: Storage) {}

  async put(key: string, body: string): Promise<number> {
    return this.storage.write(key, body);
  }

  async fetch(key: string): Promise<string> {
    return this.storage.read(key);
  }

  backend(): string {
    return this.storage.constructor.name;
  }
}
Object.defineProperty(Uploads, Symbol.for('dunx.deps'), {
  value: () => [Storage],
});

class DataDir {
  constructor(readonly path: string) {}
}

describe('FilesModule', () => {
  let root: string;

  beforeEach(() => {
    root = tempRoot();
  });

  afterEach(async () => {
    await Bun.$`rm -rf ${root}`.quiet();
  });

  it('binds Storage and the options that selected it', async () => {
    const options = new LocalStorageOptions(root);

    @Module({ imports: [FilesModule.forRoot(options)] })
    class AppModule {}

    const app = await AppFactory.create(AppModule);

    expect(app.get(Storage)).toBeInstanceOf(LocalStorage);
    expect(app.get(StorageOptions)).toBe(options);
  });

  it('accepts the configured module as the root module', async () => {
    const app = await AppFactory.create(
      FilesModule.forRoot(new LocalStorageOptions(root)),
    );

    expect(app.get(Storage)).toBeInstanceOf(LocalStorage);
  });

  it('injects Storage into a consumer through its constructor', async () => {
    @Module({
      imports: [FilesModule.forRoot(new LocalStorageOptions(root))],
      providers: [Uploads],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    const uploads = app.get(Uploads);

    expect(await uploads.put('a/b.txt', 'through DI')).toBe(10);
    expect(await uploads.fetch('a/b.txt')).toBe('through DI');
    expect(uploads.backend()).toBe('LocalStorage');
  });

  it('swaps the backend without touching the call site', async () => {
    @Module({
      imports: [
        FilesModule.forRoot(
          new S3StorageOptions({ bucket: 'b', region: 'us-east-1' }, 'p'),
        ),
      ],
      providers: [Uploads],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);

    expect(app.get(Storage)).toBeInstanceOf(S3Storage);
    expect(app.get(Uploads).backend()).toBe('S3Storage');
  });

  it('resolves an async factory before any consumer is constructed', async () => {
    @Module({
      imports: [
        FilesModule.forRootAsync({
          useFactory: async () => {
            await Bun.sleep(1);
            return new LocalStorageOptions(root);
          },
        }),
      ],
      providers: [Uploads],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);

    expect(await app.get(Uploads).put('async.txt', 'ready')).toBe(5);
  });

  it('lets the async factory inject its own dependencies', async () => {
    @Module({
      imports: [
        FilesModule.forRootAsync({
          useFactory: (dir: DataDir) => new LocalStorageOptions(dir.path),
          inject: [DataDir],
        }),
      ],
      providers: [provide(DataDir, { useValue: new DataDir(root) })],
    })
    class AppModule {}

    const app = await AppFactory.create(AppModule);
    const storage = app.get(Storage);

    await storage.write('injected.txt', 'yes');
    expect(await Bun.file(join(root, 'injected.txt')).text()).toBe('yes');
  });

  it('picks the backend from the options subclass, not from a flag', async () => {
    const app = await AppFactory.create(
      FilesModule.forRootAsync({
        useFactory: () => new S3StorageOptions({ bucket: 'b' }),
      }),
    );

    expect(app.get(Storage)).toBeInstanceOf(S3Storage);
  });
});
