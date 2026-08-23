import { sql, type SQL } from 'drizzle-orm';
import type { BunSQLDatabase } from 'drizzle-orm/bun-sql';
import { BunSQLiteDatabase } from 'drizzle-orm/bun-sqlite';
import { DatabaseError } from './errors.js';
import { transaction, type SqlTransaction } from './transaction.js';

/**
 * Either drizzle handle. Seeding is the one place this package is deliberately
 * dialect-agnostic - a seed file's own body is not, because it names tables.
 */
export type SeedableDb<TSchema extends Record<string, unknown>> =
  | BunSQLiteDatabase<TSchema>
  | BunSQLDatabase<TSchema>;

/**
 * What a seed is actually handed, which is not always the database. On
 * `bun:sqlite` there is one connection, so the transaction handle *is* the
 * database; on the pooled backend it is drizzle's `PgTransaction`, because the
 * outer handle would take a different connection and sit outside the transaction.
 *
 * A seed file annotates the one it is written for, since a body that names tables
 * is dialect-specific anyway.
 */
export type SeedHandle<TSchema extends Record<string, unknown>> =
  | BunSQLiteDatabase<TSchema>
  | SqlTransaction<TSchema>;

/**
 * What a seed file exports.
 *
 * ```ts
 * // seeds/0001_users.seeder.ts
 * export const when = (env: string): boolean => env !== 'production';
 *
 * export async function seed(db: BunSQLiteDatabase<typeof schema>): Promise<void> {
 *   await db.insert(users).values({ name: 'ada' });
 * }
 * ```
 */
export interface SeedModule<TSchema extends Record<string, unknown>> {
  readonly seed: (db: SeedHandle<TSchema>) => void | Promise<void>;
  /**
   * Whether this seed belongs in `env`. Absent means every environment. A seed
   * skipped by its predicate is **not** journaled, so it still runs the first time
   * it is invoked somewhere it does belong.
   */
  readonly when?: (env: string) => boolean;
}

export interface SeedOptions {
  /** Directory holding the numbered seed files. */
  readonly dir: string;
  /** Defaults to `NODE_ENV`, then `'development'`. */
  readonly env?: string;
  /** The journal table. Defaults to `dunx_seeds`. */
  readonly table?: string;
  /** Defaults to `*.seeder.{ts,js}` - Bun runs TypeScript, a build emits JS. */
  readonly pattern?: string;
}

export interface SeedReport {
  /** Journaled by this run, in the order they ran. */
  readonly applied: readonly string[];
  /** Already journaled, so not run again. */
  readonly journaled: readonly string[];
  /** Refused by their own `when(env)`. */
  readonly skipped: readonly string[];
}

/** A discovered file: its numeric position and its name as journaled. */
interface Discovered {
  readonly order: number;
  readonly name: string;
  readonly path: string;
}

const NUMBERED = /^(\d+)[-_]/;

const isSqlite = <TSchema extends Record<string, unknown>>(
  db: SeedableDb<TSchema>,
): db is BunSQLiteDatabase<TSchema> => db instanceof BunSQLiteDatabase;

/**
 * The two drivers share no raw-SQL method: bun-sqlite has `run`/`all`/`get` and no
 * `execute`, bun-sql has `execute` and none of the others.
 */
const exec = async <TSchema extends Record<string, unknown>>(
  db: SeedableDb<TSchema>,
  statement: SQL,
): Promise<void> => {
  if (isSqlite(db)) db.run(statement);
  else await db.execute(statement);
};

const names = async <TSchema extends Record<string, unknown>>(
  db: SeedableDb<TSchema>,
  table: string,
): Promise<ReadonlySet<string>> => {
  const query = sql`SELECT name FROM ${sql.identifier(table)}`;
  const rows = isSqlite(db)
    ? db.all<{ name: string }>(query)
    : ((await db.execute(query)) as unknown as readonly { name: string }[]);
  return new Set(rows.map((row) => row.name));
};

/**
 * `IF NOT EXISTS` so this is safe on every boot. `applied_at` is written as an ISO
 * 8601 string rather than a `Date`: `bun:sqlite` has no date type and rejects - or,
 * unstrict, silently NULLs - a `Date` binding, and Postgres parses the string into
 * `timestamptz` anyway.
 */
const journal = async <TSchema extends Record<string, unknown>>(
  db: SeedableDb<TSchema>,
  table: string,
): Promise<void> => {
  const stamp = isSqlite(db) ? sql.raw('TEXT') : sql.raw('TIMESTAMPTZ');
  await exec(
    db,
    sql`CREATE TABLE IF NOT EXISTS ${sql.identifier(table)} (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at ${stamp} NOT NULL
    )`,
  );
};

/**
 * Numbered, sorted by number, and a duplicate number is an error rather than a
 * coin flip - the whole value of a journal is that the order is the same
 * everywhere.
 */
const discover = async (
  options: SeedOptions,
): Promise<readonly Discovered[]> => {
  const pattern = options.pattern ?? '*.seeder.{ts,js}';
  const glob = new Bun.Glob(pattern);
  const found: Discovered[] = [];

  for await (const name of glob.scan({ cwd: options.dir, onlyFiles: true })) {
    const matched = NUMBERED.exec(name);
    if (matched?.[1] === undefined) {
      throw new DatabaseError(
        `Seed file "${name}" in ${options.dir} has no numeric prefix, so it has ` +
          'no place in the order. Rename it like 0001_users.seeder.ts.',
      );
    }
    found.push({
      order: Number(matched[1]),
      name,
      path: `${options.dir}/${name}`,
    });
  }

  found.sort(
    (left, right) =>
      left.order - right.order || left.name.localeCompare(right.name),
  );

  for (const [index, entry] of found.entries()) {
    const previous = found[index - 1];
    if (previous !== undefined && previous.order === entry.order) {
      throw new DatabaseError(
        `Seed files "${previous.name}" and "${entry.name}" share the number ` +
          `${entry.order}, so their order is not decidable. Renumber one.`,
      );
    }
  }

  return found;
};

const load = async <TSchema extends Record<string, unknown>>(
  entry: Discovered,
): Promise<SeedModule<TSchema>> => {
  const loaded = (await import(entry.path)) as Partial<SeedModule<TSchema>>;

  if (typeof loaded.seed !== 'function') {
    throw new DatabaseError(
      `Seed file "${entry.name}" exports no seed() function. A seed module is ` +
        '`export async function seed(db)`, optionally with `export const when`.',
    );
  }
  if (loaded.when !== undefined && typeof loaded.when !== 'function') {
    throw new DatabaseError(
      `Seed file "${entry.name}" exports \`when\` as ${typeof loaded.when}. It ` +
        'has to be a function taking the environment name.',
    );
  }

  return loaded.when === undefined
    ? { seed: loaded.seed }
    : { seed: loaded.seed, when: loaded.when };
};

/**
 * Runs every seed file in `dir` that has not run before, in numeric order, each
 * once and each recorded in a tracking table.
 *
 * Not a migration runner: schema changes are `drizzle-kit generate` plus
 * drizzle's migrator, which have no concept of data. A seed and its journal row
 * are written in one transaction, so a throwing seed leaves nothing behind.
 */
export const runSeeds = async <TSchema extends Record<string, unknown>>(
  db: SeedableDb<TSchema>,
  options: SeedOptions,
): Promise<SeedReport> => {
  const table = options.table ?? 'dunx_seeds';
  const env = options.env ?? process.env['NODE_ENV'] ?? 'development';

  const found = await discover(options);
  await journal(db, table);
  const already = await names(db, table);

  const applied: string[] = [];
  const journaled: string[] = [];
  const skipped: string[] = [];

  for (const entry of found) {
    if (already.has(entry.name)) {
      journaled.push(entry.name);
      continue;
    }

    const module = await load<TSchema>(entry);
    if (module.when?.(env) === false) {
      skipped.push(entry.name);
      continue;
    }

    // One transaction for the seed and its journal row: a throw leaves neither.
    const record = sql`INSERT INTO ${sql.identifier(table)} (name, applied_at)
      VALUES (${entry.name}, ${new Date().toISOString()})`;

    if (isSqlite(db)) {
      await transaction(db, async (tx) => {
        await module.seed(tx);
        await exec(tx, record);
      });
    } else {
      await transaction(db, async (tx) => {
        await module.seed(tx);
        await tx.execute(record);
      });
    }

    applied.push(entry.name);
  }

  return { applied, journaled, skipped };
};
