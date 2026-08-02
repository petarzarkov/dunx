import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import type { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { DatabaseError } from './errors.js';
import { runSeeds } from './seed.js';
import type { SqliteConnection } from './sqlite/connection.js';
import { SqliteOptions } from './sqlite/options.js';

const marks = sqliteTable('marks', { label: text('label').notNull() });

const schema = { marks };
type Schema = typeof schema;

const rejection = async (promise: Promise<unknown>): Promise<Error> => {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof Error))
    throw new Error('expected the promise to reject with an Error');
  return error;
};

let connection: SqliteConnection<Schema>;
let db: BunSQLiteDatabase<Schema>;
let dir: string;

/**
 * Fixtures are plain `.js` with no imports, so a directory outside the repo - which
 * cannot resolve `drizzle-orm` - is still a valid seed folder. `db.run` takes raw
 * SQL text, which is all a fixture needs.
 */
const seeder = (name: string, body: string): Promise<void> =>
  writeFile(join(dir, name), body);

const inserts = (label: string): string =>
  `export function seed(db) { db.run("INSERT INTO marks (label) VALUES ('${label}')"); }`;

const labels = (): readonly string[] =>
  db
    .select({ label: marks.label })
    .from(marks)
    .all()
    .map((row) => row.label);

const journaled = (table = 'dunx_seeds'): readonly string[] =>
  db
    .all<{ name: string }>(
      sql`SELECT name FROM ${sql.identifier(table)} ORDER BY name`,
    )
    .map((row) => row.name);

beforeEach(async () => {
  connection = await new SqliteOptions({ schema }).open();
  db = connection.db;
  db.run(sql`CREATE TABLE marks (label TEXT NOT NULL)`);
  dir = await mkdtemp(join(tmpdir(), 'dunx-seeds-'));
});

afterEach(async () => {
  await connection.close();
  await rm(dir, { recursive: true, force: true });
});

describe('the journal', () => {
  it('creates the tracking table', async () => {
    await runSeeds(db, { dir });
    expect(journaled()).toEqual([]);
  });

  it('is safe to create on every boot', async () => {
    await runSeeds(db, { dir });
    await runSeeds(db, { dir });
    expect(journaled()).toEqual([]);
  });

  it('records an applied seed by filename', async () => {
    await seeder('0001_one.seeder.js', inserts('one'));
    const report = await runSeeds(db, { dir });

    expect(report.applied).toEqual(['0001_one.seeder.js']);
    expect(journaled()).toEqual(['0001_one.seeder.js']);
    expect(labels()).toEqual(['one']);
  });

  it('records a timestamp that parses', async () => {
    await seeder('0001_one.seeder.js', inserts('one'));
    await runSeeds(db, { dir });

    const [row] = db.all<{ applied_at: string }>(
      sql`SELECT applied_at FROM dunx_seeds`,
    );
    expect(Number.isNaN(Date.parse(row?.applied_at ?? ''))).toBe(false);
  });

  it('honours a custom table name', async () => {
    await seeder('0001_one.seeder.js', inserts('one'));
    await runSeeds(db, { dir, table: 'seed_log' });
    expect(journaled('seed_log')).toEqual(['0001_one.seeder.js']);
  });
});

describe('applied once', () => {
  it('does not run a seed twice', async () => {
    await seeder('0001_one.seeder.js', inserts('one'));
    await runSeeds(db, { dir });
    const second = await runSeeds(db, { dir });

    expect(second.applied).toEqual([]);
    expect(second.journaled).toEqual(['0001_one.seeder.js']);
    expect(labels()).toEqual(['one']);
  });

  it('runs only the newcomer when one is added later', async () => {
    await seeder('0001_one.seeder.js', inserts('one'));
    await runSeeds(db, { dir });

    await seeder('0002_two.seeder.js', inserts('two'));
    const second = await runSeeds(db, { dir });

    expect(second.applied).toEqual(['0002_two.seeder.js']);
    expect(second.journaled).toEqual(['0001_one.seeder.js']);
    expect(labels()).toEqual(['one', 'two']);
  });

  it('survives a reopened database, because the record is in the database', async () => {
    const file = join(dir, 'seeded.db');
    const options = new SqliteOptions({ schema, filename: file });

    const first = await options.open();
    first.db.run(sql`CREATE TABLE marks (label TEXT NOT NULL)`);
    await seeder('0001_one.seeder.js', inserts('one'));
    await runSeeds(first.db, { dir });
    await first.close();

    const second = await options.open();
    const report = await runSeeds(second.db, { dir });
    expect(report.applied).toEqual([]);
    expect(report.journaled).toEqual(['0001_one.seeder.js']);
    await second.close();
  });
});

describe('order', () => {
  it('runs in numeric order, not lexical', async () => {
    await seeder('0002_second.seeder.js', inserts('second'));
    await seeder('0010_tenth.seeder.js', inserts('tenth'));
    await seeder('0001_first.seeder.js', inserts('first'));

    const report = await runSeeds(db, { dir });
    expect(report.applied).toEqual([
      '0001_first.seeder.js',
      '0002_second.seeder.js',
      '0010_tenth.seeder.js',
    ]);
    expect(labels()).toEqual(['first', 'second', 'tenth']);
  });

  it('orders unpadded numbers by value', async () => {
    await seeder('9_nine.seeder.js', inserts('nine'));
    await seeder('10_ten.seeder.js', inserts('ten'));
    expect((await runSeeds(db, { dir })).applied).toEqual([
      '9_nine.seeder.js',
      '10_ten.seeder.js',
    ]);
  });

  it('accepts a dash as the separator', async () => {
    await seeder('0001-one.seeder.js', inserts('one'));
    expect((await runSeeds(db, { dir })).applied).toEqual([
      '0001-one.seeder.js',
    ]);
  });

  it('refuses a file with no number, which would have no place in the order', async () => {
    await seeder('users.seeder.js', inserts('one'));
    const error = await rejection(runSeeds(db, { dir }));

    expect(error).toBeInstanceOf(DatabaseError);
    expect(error.message).toContain('users.seeder.js');
    expect(error.message).toContain('numeric prefix');
  });

  it('refuses two files sharing a number', async () => {
    await seeder('0001_one.seeder.js', inserts('one'));
    await seeder('0001_other.seeder.js', inserts('other'));
    const error = await rejection(runSeeds(db, { dir }));

    expect(error).toBeInstanceOf(DatabaseError);
    expect(error.message).toContain('share the number 1');
    expect(labels()).toEqual([]);
  });

  it('ignores a file that is not a seeder at all', async () => {
    await seeder('helpers.js', 'export const help = 1;');
    await seeder('0001_one.seeder.js', inserts('one'));
    expect((await runSeeds(db, { dir })).applied).toEqual([
      '0001_one.seeder.js',
    ]);
  });

  it('honours a custom pattern', async () => {
    await seeder('0001_one.data.js', inserts('one'));
    await seeder('0002_two.seeder.js', inserts('two'));
    const report = await runSeeds(db, { dir, pattern: '*.data.js' });
    expect(report.applied).toEqual(['0001_one.data.js']);
  });

  it('reports nothing for an empty directory', async () => {
    expect(await runSeeds(db, { dir })).toEqual({
      applied: [],
      journaled: [],
      skipped: [],
    });
  });
});

describe('the environment predicate', () => {
  it('skips a seed its own when() refuses', async () => {
    await seeder(
      '0001_dev.seeder.js',
      `export const when = (env) => env === 'development';\n${inserts('dev')}`,
    );
    const report = await runSeeds(db, { dir, env: 'production' });

    expect(report.skipped).toEqual(['0001_dev.seeder.js']);
    expect(report.applied).toEqual([]);
    expect(labels()).toEqual([]);
  });

  it('does not journal a skipped seed, so it can still run elsewhere', async () => {
    const body = `export const when = (env) => env === 'development';\n${inserts('dev')}`;
    await seeder('0001_dev.seeder.js', body);

    await runSeeds(db, { dir, env: 'production' });
    expect(journaled()).toEqual([]);

    const later = await runSeeds(db, { dir, env: 'development' });
    expect(later.applied).toEqual(['0001_dev.seeder.js']);
    expect(labels()).toEqual(['dev']);
  });

  it('runs a seed with no when() in every environment', async () => {
    await seeder('0001_always.seeder.js', inserts('always'));
    expect((await runSeeds(db, { dir, env: 'production' })).applied).toEqual([
      '0001_always.seeder.js',
    ]);
  });

  it('hands when() the environment name', async () => {
    await seeder(
      '0001_probe.seeder.js',
      `export const when = (env) => env === 'staging';\n${inserts('staging')}`,
    );
    expect((await runSeeds(db, { dir, env: 'staging' })).applied).toEqual([
      '0001_probe.seeder.js',
    ]);
  });

  it('defaults the environment to NODE_ENV', async () => {
    // bun test sets NODE_ENV=test.
    await seeder(
      '0001_test.seeder.js',
      `export const when = (env) => env === ${JSON.stringify(process.env['NODE_ENV'] ?? 'development')};\n${inserts('t')}`,
    );
    expect((await runSeeds(db, { dir })).applied).toEqual([
      '0001_test.seeder.js',
    ]);
  });

  it('reports applied, journaled and skipped together', async () => {
    await seeder('0001_one.seeder.js', inserts('one'));
    await runSeeds(db, { dir });

    await seeder('0002_two.seeder.js', inserts('two'));
    await seeder(
      '0003_never.seeder.js',
      `export const when = () => false;\n${inserts('never')}`,
    );

    expect(await runSeeds(db, { dir })).toEqual({
      applied: ['0002_two.seeder.js'],
      journaled: ['0001_one.seeder.js'],
      skipped: ['0003_never.seeder.js'],
    });
  });

  it('refuses a when that is not a function', async () => {
    await seeder(
      '0001_bad.seeder.js',
      `export const when = 'development';\n${inserts('bad')}`,
    );
    const error = await rejection(runSeeds(db, { dir }));
    expect(error).toBeInstanceOf(DatabaseError);
    expect(error.message).toContain('exports `when` as string');
  });
});

describe('a seed that fails', () => {
  it('leaves no journal row and no data', async () => {
    await seeder(
      '0001_broken.seeder.js',
      `export async function seed(db) {
        db.run("INSERT INTO marks (label) VALUES ('half')");
        await Bun.sleep(1);
        throw new Error('seed blew up');
      }`,
    );

    const error = await rejection(runSeeds(db, { dir }));
    expect(error.message).toBe('seed blew up');
    // Both halves of the same transaction - and the insert is before an await,
    // which is exactly what drizzle's own bun-sqlite transaction cannot undo.
    expect(labels()).toEqual([]);
    expect(journaled()).toEqual([]);
  });

  it('stops before the seeds after it', async () => {
    await seeder(
      '0001_broken.seeder.js',
      'export function seed() { throw new Error("first fails"); }',
    );
    await seeder('0002_later.seeder.js', inserts('later'));

    await rejection(runSeeds(db, { dir }));
    expect(labels()).toEqual([]);
    expect(journaled()).toEqual([]);
  });

  it('keeps the seeds that already succeeded', async () => {
    await seeder('0001_ok.seeder.js', inserts('ok'));
    await seeder(
      '0002_broken.seeder.js',
      'export function seed() { throw new Error("second fails"); }',
    );

    await rejection(runSeeds(db, { dir }));
    expect(labels()).toEqual(['ok']);
    expect(journaled()).toEqual(['0001_ok.seeder.js']);
  });

  it('is retried on the next run, since it was never journaled', async () => {
    await seeder(
      '0001_flaky.seeder.js',
      `let attempts = 0;
      export function seed(db) {
        attempts += 1;
        if (attempts === 1) throw new Error('boom');
        db.run("INSERT INTO marks (label) VALUES ('second attempt')");
      }`,
    );

    expect((await rejection(runSeeds(db, { dir }))).message).toBe('boom');
    expect(journaled()).toEqual([]);

    const report = await runSeeds(db, { dir });
    expect(report.applied).toEqual(['0001_flaky.seeder.js']);
    expect(labels()).toEqual(['second attempt']);
  });

  it('refuses a file that exports no seed()', async () => {
    await seeder('0001_empty.seeder.js', 'export const nothing = 1;');
    const error = await rejection(runSeeds(db, { dir }));

    expect(error).toBeInstanceOf(DatabaseError);
    expect(error.message).toContain('0001_empty.seeder.js');
    expect(error.message).toContain('no seed() function');
  });

  it('refuses a seed export that is not a function', async () => {
    await seeder('0001_wrong.seeder.js', 'export const seed = 42;');
    const error = await rejection(runSeeds(db, { dir }));
    expect(error.message).toContain('no seed() function');
  });
});

describe('what a seed is handed', () => {
  it('the drizzle handle, so it can use the query builder', async () => {
    await seeder(
      '0001_builder.seeder.js',
      `export async function seed(db) {
        await db.insert(db._.fullSchema.marks).values({ label: 'via builder' });
      }`,
    );
    await runSeeds(db, { dir });
    expect(labels()).toEqual(['via builder']);
  });

  it('a handle already inside the transaction', async () => {
    await seeder(
      '0001_reads.seeder.js',
      `export function seed(db) {
        db.run("INSERT INTO marks (label) VALUES ('a')");
        const rows = db.all("SELECT label FROM marks");
        if (rows.length !== 1) throw new Error('own write not visible');
      }`,
    );
    expect((await runSeeds(db, { dir })).applied).toHaveLength(1);
  });

  it('awaits an async seed before journaling it', async () => {
    await seeder(
      '0001_slow.seeder.js',
      `export async function seed(db) {
        await Bun.sleep(2);
        db.run("INSERT INTO marks (label) VALUES ('slow')");
      }`,
    );
    await runSeeds(db, { dir });
    expect(labels()).toEqual(['slow']);
    expect(journaled()).toEqual(['0001_slow.seeder.js']);
  });
});
