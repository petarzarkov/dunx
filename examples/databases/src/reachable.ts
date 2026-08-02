/**
 * Whether a server-backed database is actually up.
 *
 * Every example in this repo has to exit 0 with nothing installed, otherwise CI
 * teaches everyone to ignore it. SQLite is always live - it is a file, or not even
 * that. Postgres and MySQL are not, so each is probed once before its module is
 * imported, and the run reports that it is skipping instead of failing.
 *
 * The probe is `Bun.SQL`'s own handshake with a short timeout, not a TCP dial: a
 * port that accepts a connection but rejects the credentials is not reachable for
 * any purpose this example has.
 */
export const reachable = async (url: string): Promise<string | null> => {
  // `new Bun.SQL(new URL(url))` rather than `{ url }`: the options-object form lets
  // `POSTGRES_URL` in the environment override an explicitly passed URL on Bun
  // 1.3.14, which would probe Postgres and report MySQL down. See docs/bun-apis.md.
  const client = new Bun.SQL(new URL(url));
  try {
    await client.connect();
    return null;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    // The message alone is usually "Connection closed", which names nothing. The
    // host and port are the part worth printing.
    return `${why} (${new URL(url).host})`;
  } finally {
    await client.close().catch(() => undefined);
  }
};
