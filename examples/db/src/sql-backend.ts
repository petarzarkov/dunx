import { SqlOptions } from '@dunx/db';

/**
 * The `Bun.SQL` path, over a socket. CI has no server, so an unreachable one is
 * reported and skipped rather than allowed to fail the run.
 *
 * Note the URL: `Bun.SQL` speaks SQLite too, so the same client covers Postgres,
 * MySQL, MariaDB *and* SQLite. Prefer `bun:sqlite` for SQLite anyway — see the
 * package README.
 */
export const trySqlBackend = async (
  log: (line: string) => void,
): Promise<void> => {
  const url =
    process.env['DATABASE_URL'] ??
    'postgres://postgres:postgres@127.0.0.1:5432/postgres';

  let options: SqlOptions;
  try {
    // The dialect is resolved here, from the URL, before any I/O happens.
    options = new SqlOptions({ url, max: 1, connectionTimeout: 2 });
  } catch (error) {
    log(
      `Bun.SQL skipped — ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }

  log(`Bun.SQL url names dialect "${options.dialect}"`);

  try {
    const db = await options.open();
    const row = await db.sql<{ answer: number }>`SELECT ${42} AS answer`.get();
    log(`Bun.SQL connected: ${db.dialect} answered ${row?.answer}`);
    await db.close();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`Bun.SQL skipped — no server reachable at ${url} (${reason})`);
  }
};
