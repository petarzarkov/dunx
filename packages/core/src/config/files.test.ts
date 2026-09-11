import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppFactory } from '../di/app.js';
import { Module } from '../di/module.js';
import { ConfigFiles, type ConfigValues } from './files.js';
import { ConfigModule } from './module.js';
import { ConfigError, ConfigService } from './service.js';

const dir = mkdtempSync(join(tmpdir(), 'dunx-config-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Returns the bare name, since `ConfigFiles` resolves against its cwd. */
const write = async (name: string, text: string): Promise<string> => {
  await Bun.write(join(dir, name), text);
  return name;
};

const load = (...paths: string[]): Promise<ConfigValues> =>
  new ConfigFiles(paths, dir).load();

describe('ConfigFiles', () => {
  it('parses yaml with its types intact', async () => {
    const path = await write(
      'typed.yml',
      'server:\n  port: 3000\n  host: "0.0.0.0"\nssl: false\ntags: [a, b]\n',
    );

    expect(await load(path)).toEqual({
      server: { port: 3000, host: '0.0.0.0' },
      ssl: false,
      tags: ['a', 'b'],
    });
  });

  it('parses toml and json by extension', async () => {
    const toml = await write('conf.toml', '[server]\nport = 8080\n');
    const json = await write('conf.json', '{"server":{"host":"json"}}');

    expect(await load(toml)).toEqual({ server: { port: 8080 } });
    expect(await load(json)).toEqual({ server: { host: 'json' } });
  });

  it('deep-merges later files over earlier ones, per key', async () => {
    const base = await write(
      'base.yml',
      'server:\n  port: 3000\n  host: base\ndb:\n  pool: 10\n',
    );
    const overlay = await write('overlay.yml', 'server:\n  host: overlay\n');

    // `port` survives because the overlay did not name it.
    expect(await load(base, overlay)).toEqual({
      server: { port: 3000, host: 'overlay' },
      db: { pool: 10 },
    });
  });

  it('replaces an array rather than concatenating it', async () => {
    const base = await write('arr-base.yml', 'hosts: [a, b]\n');
    const overlay = await write('arr-over.yml', 'hosts: [c]\n');

    expect(await load(base, overlay)).toEqual({ hosts: ['c'] });
  });

  it('skips a file that does not exist', async () => {
    const present = await write('present.yml', 'a: 1\n');

    expect(await load('absent.yml', present, 'also-absent.toml')).toEqual({
      a: 1,
    });
    expect(await load('absent.yml')).toEqual({});
  });

  it('skips an empty file and one holding only comments', async () => {
    const empty = await write('empty.yml', '');
    const comments = await write('comments.yml', '# nothing here\n');
    const real = await write('real.yml', 'a: 1\n');

    expect(await load(empty, comments, real)).toEqual({ a: 1 });
  });

  it('rejects a file whose top level is not an object', async () => {
    const list = await write('list.yml', '- a\n- b\n');
    const scalar = await write('scalar.yml', '42\n');

    await expect(load(list)).rejects.toThrow(
      /must hold an object.*got an array/s,
    );
    // A stray `---` is the way a config file becomes a list by accident.
    await expect(load(scalar)).rejects.toThrow(
      /must hold an object.*got number/s,
    );
  });

  it('names the file when a parser throws', async () => {
    const bad = await write('bad.toml', '= oops\n');

    await expect(load(bad)).rejects.toThrow(ConfigError);
    await expect(load(bad)).rejects.toThrow(/"bad\.toml" did not parse/);
  });

  it('rejects an extension it has no parser for', async () => {
    const ini = await write('conf.ini', 'a=1\n');

    await expect(load(ini)).rejects.toThrow(
      /no parser.*\.yml, \.yaml, \.toml/s,
    );
  });

  it('defaults its cwd to the process working directory', async () => {
    // Nothing by this name exists at the repo root, so an absent file is the
    // observable half: it resolves and skips rather than throwing.
    expect(await new ConfigFiles(['definitely-not-here.yml']).load()).toEqual(
      {},
    );
  });
});

describe('ConfigModule with files', () => {
  interface AppConfig {
    readonly server: { readonly port: number; readonly host: string };
    readonly db: { readonly pool: number };
  }

  it('merges the files and keeps their types through validate', async () => {
    const base = await write(
      'app.yml',
      'server:\n  port: 3000\n  host: base\ndb:\n  pool: 10\n',
    );
    const overlay = await write('app-test.yml', 'server:\n  host: test\n');

    @Module({
      imports: [
        ConfigModule.forRoot({
          files: [join(dir, base), join(dir, overlay)],
          source: {},
          validate: (src: ConfigValues) => src as unknown as AppConfig,
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const config = app.get(ConfigService<AppConfig>);

    expect(config.get('server.port')).toBe(3000);
    expect(config.get('server.host')).toBe('test');
    expect(config.get('db.pool')).toBe(10);
    await app.shutdown();
  });

  it('lets the environment override a file key of the same name', async () => {
    const file = await write('over.yml', 'PORT: 3000\nkept: yes\n');
    interface Overridden {
      readonly PORT: string;
      readonly kept: string;
    }

    @Module({
      imports: [
        ConfigModule.forRoot({
          files: [join(dir, file)],
          source: { PORT: '8080' },
          validate: (src: ConfigValues) => src as unknown as Overridden,
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const config = app.get(ConfigService<Overridden>);

    // The environment is spread last, so it wins on an exact name match and
    // leaves everything it does not name alone.
    expect(config.get('PORT')).toBe('8080');
    expect(config.get('kept')).toBe('yes');
    await app.shutdown();
  });

  it('fails boot with the parse error when a listed file is broken', async () => {
    const broken = await write('broken.yml', 'a:\n - b\n  c: bad\n');

    @Module({
      imports: [
        ConfigModule.forRoot({
          files: [join(dir, broken)],
          source: {},
          validate: (src: ConfigValues) => src,
        }),
      ],
    })
    class Root {}

    await expect(AppFactory.create(Root)).rejects.toThrow(/did not parse/);
  });
});
