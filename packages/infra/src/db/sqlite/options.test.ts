import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Backend } from '../contract.js';
import { DatabaseError } from '../errors.js';
import { SqliteOptions } from './options.js';

/**
 * The repo's rejection idiom: await the promise, keep the reason. `expect().rejects`
 * is typed as non-thenable by bun:test, which makes the assertion a lint warning.
 */
const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error;
};

// A real file, in an OS temp directory that is removed whole afterwards — WAL and
// SHM siblings included. Nothing file-backed is written inside the repo.
let directory: string;
let scratch: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dunx-db-'));
  scratch = join(directory, 'scratch.db');
});

afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('SqliteOptions', () => {
  it('defaults to an in-memory database', () => {
    const options = new SqliteOptions();
    expect(options.backend).toBe(Backend.SQLITE);
    expect(options.filename).toBe(':memory:');
    expect(options.create).toBe(true);
    expect(options.readOnly).toBe(false);
    expect(options.pragmas).toEqual([]);
  });

  it('defaults strict on, unlike the driver', () => {
    expect(new SqliteOptions().strict).toBe(true);
    expect(new SqliteOptions({ strict: false }).strict).toBe(false);
  });

  it.each([
    [':memory:', ':memory:'],
    ['sqlite://:memory:', ':memory:'],
    ['sqlite://./dev.db', './dev.db'],
    ['sqlite:///var/lib/app.db', '/var/lib/app.db'],
    ['sqlite:dev.db', 'dev.db'],
    ['file:./dev.db', './dev.db'],
    ['file://./dev.db', './dev.db'],
    ['./dev.db', './dev.db'],
    ['/var/lib/app.db', '/var/lib/app.db'],
  ])('reads %p as the path %p', (input, expected) => {
    expect(new SqliteOptions({ filename: input }).filename).toBe(expected);
  });

  it('accepts a URL object', () => {
    expect(
      new SqliteOptions({ filename: new URL('file:///var/lib/app.db') })
        .filename,
    ).toBe('/var/lib/app.db');
  });

  it.each(['sqlite://', 'file:', 'sqlite:'])(
    'rejects %p, which names no database',
    (input) => {
      expect(() => new SqliteOptions({ filename: input })).toThrow(
        DatabaseError,
      );
    },
  );

  it('maps create and readOnly onto mutually exclusive driver flags', () => {
    expect(new SqliteOptions().toDriverOptions()).toEqual({
      strict: true,
      safeIntegers: false,
      create: true,
    });
    expect(
      new SqliteOptions({ readOnly: true, create: true }).toDriverOptions(),
    ).toEqual({ strict: true, safeIntegers: false, readonly: true });
  });

  it('applies pragmas before the first query', async () => {
    const db = await new SqliteOptions({
      filename: scratch,
      pragmas: ['journal_mode = WAL', 'synchronous = NORMAL'],
    }).open();

    expect(
      await db.get<{ journal_mode: string }>('PRAGMA journal_mode'),
    ).toEqual({ journal_mode: 'wal' });
    await db.close();
  });

  it('returns bigints when safeIntegers is set', async () => {
    const db = await new SqliteOptions({ safeIntegers: true }).open();
    expect(await db.get<{ n: bigint }>('SELECT 1 AS n')).toEqual({ n: 1n });
    await db.close();
  });

  it('opens read-only, so a write fails', async () => {
    const seed = await new SqliteOptions({ filename: scratch }).open();
    await seed.exec('CREATE TABLE IF NOT EXISTS t (x INT)');
    await seed.close();

    const db = await new SqliteOptions({
      filename: scratch,
      readOnly: true,
    }).open();
    expect(
      (await rejection(db.run('INSERT INTO t VALUES (1)'))).message,
    ).toMatch(/readonly/i);
    await db.close();
  });
});
