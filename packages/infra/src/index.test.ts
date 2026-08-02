import { describe, expect, it } from 'bun:test';
import * as db from './db/index.js';
import * as files from './files/index.js';
import * as images from './images/index.js';
import * as root from './index.js';
import * as logger from './logger/index.js';
import * as queue from './queue/index.js';
import * as redis from './redis/index.js';

const included = { db, files, images, logger, redis };

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
   * The single exception, and the reason it is one: bullmq's own entry point
   * imports `ioredis` statically, so a queue symbol here would make ioredis a hard
   * requirement of `import '@dunx/infra'` for every consumer, queue or no. If that
   * ever stops being true, this is the test that says the exception can go.
   */
  it('keeps /queue out, so the root needs no bullmq', () => {
    expect(names.filter((name) => name in queue)).toEqual([]);
  });
});
