import { describe, expect, it } from 'bun:test';
import * as amqp from './amqp/index.js';
import * as cache from './cache/index.js';
import * as db from './db/index.js';
import * as email from './email/index.js';
import * as files from './files/index.js';
import * as images from './images/index.js';
import * as root from './index.js';
import * as logger from './logger/index.js';
import * as queue from './queue/index.js';
import * as redis from './redis/index.js';
import * as schedule from './schedule/index.js';

const included = { cache, files, images, logger, redis, schedule };

/**
 * The root barrel used to be a partial re-export of five of the six areas as well
 * as of `/queue`: half of `/db`'s synchronous mode was reachable only from the
 * subpath, which made guessing which barrel a symbol was on trial and error. The
 * rule the doc comment on `index.ts` states is what these assert.
 */
describe('@dunx/infra root barrel', () => {
  const names = Object.keys(root);

  it.each(Object.entries(included))(
    're-exports every value on /%s',
    (_area, area) => {
      const missing = Object.keys(area).filter(
        (symbol) => !names.includes(symbol),
      );
      expect(missing).toEqual([]);
    },
  );

  it('exports nothing an area does not', () => {
    const known = new Set(
      Object.values(included).flatMap((area) => Object.keys(area)),
    );
    expect(names.filter((name) => !known.has(name))).toEqual([]);
  });

  /**
   * The three exceptions, and the reason they are exceptions: each reaches an
   * optional peer through a static import, so one symbol from any of them here
   * would make that peer a hard requirement of `import '@dunx/infra'` for every
   * consumer. bullmq's entry point imports `ioredis`; `/db` imports `drizzle-orm`;
   * `/amqp` imports `rabbitmq-client`. If one ever stops being true, this is the
   * test that says so.
   */
  it.each([
    ['queue', queue, 'bullmq'],
    ['db', db, 'drizzle-orm'],
    ['amqp', amqp, 'rabbitmq-client'],
    ['email', email, 'resend'],
  ])('keeps /%s out, so the root needs no %s', (_area, area) => {
    expect(names.filter((name) => name in area)).toEqual([]);
  });
});

/**
 * `/email` is the one area whose peers sit a level below it: the base subpath
 * reaches none, and each vendor subpath reaches exactly one. The README says a
 * consumer can import `@dunx/infra/email` with none of the four installed, and
 * these are what keep that true rather than merely written down.
 */
describe('the /email vendor peers stay in their own subpaths', () => {
  const VENDORS = ['resend', 'nodemailer', 'react', '@react-email/render'];

  const sources = async (): Promise<Map<string, string>> => {
    const found = new Map<string, string>();
    const glob = new Bun.Glob('**/*.ts');
    for await (const file of glob.scan({ cwd: `${import.meta.dir}/email` })) {
      if (/\.(test|fixture)\.ts$/.test(file)) continue;
      found.set(
        file,
        await Bun.file(`${import.meta.dir}/email/${file}`).text(),
      );
    }
    return found;
  };

  it.each([
    ['resend', 'resend/index.ts'],
    ['nodemailer', 'smtp/index.ts'],
    ['react', 'react/index.ts'],
    ['@react-email/render', 'react/index.ts'],
  ])('imports %s only from %s', async (vendor, owner) => {
    const importing = [...(await sources())]
      .filter(([, text]) => text.includes(`from '${vendor}'`))
      .map(([file]) => file);

    expect(importing).toEqual([owner]);
  });

  /** The base subpath, and everything it pulls in, reaches none of them. */
  it('leaves the base subpath free of all four', async () => {
    const base = [...(await sources())].filter(([file]) => !file.includes('/'));

    for (const [file, text] of base) {
      for (const vendor of VENDORS) {
        expect(`${file}: ${String(text.includes(`from '${vendor}'`))}`).toBe(
          `${file}: false`,
        );
      }
    }
  });

  it('marks every one of them optional', async () => {
    const manifest = (await Bun.file(
      `${import.meta.dir}/../package.json`,
    ).json()) as Record<string, unknown>;
    const meta = manifest['peerDependenciesMeta'] as Record<
      string,
      { optional?: boolean }
    >;

    for (const vendor of VENDORS) {
      expect(`${vendor}: ${String(meta[vendor]?.optional)}`).toBe(
        `${vendor}: true`,
      );
    }
  });
});

/**
 * dunx never imports `ioredis` - it is declared only so that installing `/queue`
 * produces something that loads, because bullmq reaches it from `utils/index` in
 * both its builds. So dunx has no opinion of its own about which versions are
 * acceptable, and the only honest range is the one bullmq itself declares.
 * Mirroring it by hand is how it goes stale; this is the guard.
 */
describe("the ioredis peer range is bullmq's, not dunx's", () => {
  const read = async (path: string): Promise<Record<string, unknown>> =>
    (await Bun.file(path).json()) as Record<string, unknown>;

  it('declares exactly what the installed bullmq declares', async () => {
    const mine = await read(
      new URL('../package.json', import.meta.url).pathname,
    );
    const theirs = await read(
      Bun.resolveSync('bullmq/package.json', import.meta.dir),
    );

    const peer = (json: Record<string, unknown>): string | undefined =>
      (json['peerDependencies'] as Record<string, string> | undefined)?.[
        'ioredis'
      ];

    expect(peer(mine)).toBe(peer(theirs));
  });

  /**
   * Both are optional, and they are optional *together*: `/queue` needs both or
   * neither. npm has no way to say that, so the pairing lives here and in guide 14.
   */
  it('marks ioredis optional exactly as it marks bullmq', async () => {
    const mine = await read(
      new URL('../package.json', import.meta.url).pathname,
    );
    const meta = mine['peerDependenciesMeta'] as Record<
      string,
      { optional?: boolean }
    >;

    expect(meta['ioredis']?.optional).toBe(true);
    expect(meta['bullmq']?.optional).toBe(true);
  });
});
