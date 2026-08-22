import { describe, expect, it } from 'bun:test';
import * as db from './db/index.js';
import * as files from './files/index.js';
import * as images from './images/index.js';
import * as root from './index.js';
import * as logger from './logger/index.js';
import * as queue from './queue/index.js';
import * as redis from './redis/index.js';
import * as schedule from './schedule/index.js';

const included = { files, images, logger, redis, schedule };

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
   * The two exceptions, and the reason they are exceptions: each reaches an
   * optional peer through a static import, so one symbol from either here would
   * make that peer a hard requirement of `import '@dunx/infra'` for every
   * consumer. bullmq's entry point imports `ioredis`; `/db` imports `drizzle-orm`.
   * If either ever stops being true, this is the test that says so.
   */
  it.each([
    ['queue', queue, 'bullmq'],
    ['db', db, 'drizzle-orm'],
  ])('keeps /%s out, so the root needs no %s', (_area, area) => {
    expect(names.filter((name) => name in area)).toEqual([]);
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
