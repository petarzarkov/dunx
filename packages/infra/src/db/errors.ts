import { AppError } from '@dunx/core';

/** Raised by `@dunx/infra/db` itself. Driver failures propagate as the driver's own error. */
export class DatabaseError extends AppError {
  override name = 'DatabaseError';
}

/**
 * Which rule the database refused to break. A closed set, because these are the
 * four every supported dialect reports distinctly and the four an application
 * has a different answer for.
 */
export const ConstraintKind = Object.freeze({
  Unique: 'unique',
  ForeignKey: 'foreign_key',
  NotNull: 'not_null',
  Check: 'check',
} as const);
export type ConstraintKind =
  (typeof ConstraintKind)[keyof typeof ConstraintKind];

/**
 * A constraint the database enforced, as an error carrying the status it should
 * answer with.
 *
 * `AppError.status` is an integer and nothing here imports `@dunx/http` - the web
 * layer reads the number off any `AppError` that set one. So a repository letting
 * this propagate answers 409 rather than 500, with no error filter in between and
 * no database knowledge in the HTTP layer.
 *
 * **The message is deliberately generic and the driver's is not in it.**
 * `@dunx/http`'s mapper sends `error.message` to the caller for a 4xx, and a
 * driver message names the table, the column and the constraint - so
 * `duplicate key value violates unique constraint "users_email_key"` would put
 * the schema in a response body. The original is `cause`, which is logged.
 */
export class ConstraintError extends DatabaseError {
  override readonly name = 'ConstraintError';

  constructor(
    readonly kind: ConstraintKind,
    override readonly status: number,
    message: string,
    /**
     * The constraint the driver named, where it named one: `users_email_key` on
     * Postgres, `users.email` on SQLite, the index name on MySQL. Absent for the
     * cases a driver reports without one, such as a SQLite foreign key.
     */
    readonly constraint: string | undefined,
    /** `SQLITE_CONSTRAINT_UNIQUE`, the SQLSTATE `23505`, the MySQL `1062`. */
    readonly driverCode: string,
    cause: unknown,
  ) {
    super(message, { cause });
  }
}

/**
 * A conflict with data that is already there, rather than a malformed request.
 * A foreign key is here rather than with the 400s because the two ways to break
 * one - inserting a child whose parent is absent, and deleting a parent that
 * still has children - are indistinguishable from the driver's code, and only
 * one of them is the caller sending a bad value.
 */
const KIND_STATUS: Readonly<Record<ConstraintKind, number>> = Object.freeze({
  [ConstraintKind.Unique]: 409,
  [ConstraintKind.ForeignKey]: 409,
  [ConstraintKind.NotNull]: 400,
  [ConstraintKind.Check]: 400,
});

const KIND_MESSAGE: Readonly<Record<ConstraintKind, string>> = Object.freeze({
  [ConstraintKind.Unique]: 'A record with these values already exists',
  [ConstraintKind.ForeignKey]: 'A related record is missing or still in use',
  [ConstraintKind.NotNull]: 'A required value was missing',
  [ConstraintKind.Check]: 'A value failed a database check',
});

/**
 * `bun:sqlite` puts a symbolic code on `.code`. `SQLITE_CONSTRAINT_PRIMARYKEY`
 * and `SQLITE_CONSTRAINT_UNIQUE` are the same violation reported against
 * different indexes, and both read `UNIQUE constraint failed` in the message.
 */
const SQLITE_KINDS: Readonly<Record<string, ConstraintKind>> = Object.freeze({
  SQLITE_CONSTRAINT_UNIQUE: ConstraintKind.Unique,
  SQLITE_CONSTRAINT_PRIMARYKEY: ConstraintKind.Unique,
  SQLITE_CONSTRAINT_FOREIGNKEY: ConstraintKind.ForeignKey,
  SQLITE_CONSTRAINT_NOTNULL: ConstraintKind.NotNull,
  SQLITE_CONSTRAINT_CHECK: ConstraintKind.Check,
});

/**
 * SQLSTATE, class 23. **Read off `errno`, not `code`** - `Bun.SQL` puts its own
 * label in `code` (`ERR_POSTGRES_SERVER_ERROR` for all five of these), which is
 * the opposite of where every Node Postgres client keeps the SQLSTATE. Measured
 * against Postgres 16; recorded in docs/bun-apis.md.
 */
const POSTGRES_KINDS: Readonly<Record<string, ConstraintKind>> = Object.freeze({
  '23505': ConstraintKind.Unique,
  '23503': ConstraintKind.ForeignKey,
  '23502': ConstraintKind.NotNull,
  '23514': ConstraintKind.Check,
});

/**
 * MySQL's own error numbers, each one provoked out of MySQL 8.0 rather than read
 * off a reference. `errno` is a **number** here and a string on Postgres, which
 * is why the lookup goes through `String()`.
 *
 * `1451` and `1452` are the two sides of a foreign key - deleting a parent that
 * still has children, and inserting a child whose parent is absent. A duplicate
 * primary key reports `1062`, the same as any other duplicate index entry.
 */
const MYSQL_KINDS: Readonly<Record<string, ConstraintKind>> = Object.freeze({
  '1062': ConstraintKind.Unique,
  '1451': ConstraintKind.ForeignKey,
  '1452': ConstraintKind.ForeignKey,
  '1048': ConstraintKind.NotNull,
  '3819': ConstraintKind.Check,
});

const field = (error: object, key: string): string | undefined => {
  const value = (error as Record<string, unknown>)[key];
  return typeof value === 'string' || typeof value === 'number'
    ? String(value)
    : undefined;
};

/** `UNIQUE constraint failed: users.email` -> `users.email`. */
const sqliteConstraint = (message: string): string | undefined => {
  const named = /constraint failed: (.+)$/.exec(message);
  return named?.[1];
};

const classify = (
  error: object,
):
  | { kind: ConstraintKind; code: string; constraint: string | undefined }
  | undefined => {
  const name = field(error, 'name');
  const message = field(error, 'message') ?? '';

  if (name === 'SQLiteError') {
    const code = field(error, 'code') ?? '';
    const kind = SQLITE_KINDS[code];
    return kind === undefined
      ? undefined
      : { kind, code, constraint: sqliteConstraint(message) };
  }

  // Every `Bun.SQL` backend reports through its own class - `PostgresError`,
  // `MySQLError` - and both put the server's code in `errno`. Read both tables
  // rather than branching on the class name, since the two code spaces do not
  // overlap: a SQLSTATE is five characters, a MySQL number is four digits.
  const errno = field(error, 'errno');
  if (errno === undefined) return undefined;
  const kind = POSTGRES_KINDS[errno] ?? MYSQL_KINDS[errno];
  return kind === undefined
    ? undefined
    : { kind, code: errno, constraint: field(error, 'constraint') };
};

/**
 * Turns a driver error into a `ConstraintError` when it is one, and returns the
 * error untouched when it is not.
 *
 * Not a `try`/`catch` around every query: drizzle owns the query path and
 * wrapping it would mean restating its surface. This is the classifier the seams
 * `@dunx/infra` does own call - `transaction`, `transactionSync`, `runSeeds` -
 * and the one a repository or an error filter calls for anything else.
 *
 * ```ts
 * try {
 *   await this.db.insert(users).values(input);
 * } catch (error) {
 *   throw toDatabaseError(error);
 * }
 * ```
 */
export const toDatabaseError = (error: unknown): unknown => {
  if (typeof error !== 'object' || error === null) return error;
  if (error instanceof DatabaseError) return error;

  const found = classify(error);
  if (found === undefined) return error;

  return new ConstraintError(
    found.kind,
    KIND_STATUS[found.kind],
    KIND_MESSAGE[found.kind],
    found.constraint,
    found.code,
    error,
  );
};
