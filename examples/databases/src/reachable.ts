/**
 * Whether a server-backed database is up, so the example can skip and still exit
 * 0. A full handshake rather than a TCP dial: a port that accepts a connection
 * but rejects the credentials is not reachable for anything here.
 */
export const reachable = async (url: string): Promise<string | null> => {
  // `new URL(url)` rather than `{ url }`: the options-object form lets
  // `POSTGRES_URL` override it and report MySQL down. See docs/bun-apis.md.
  const client = new Bun.SQL(new URL(url));
  try {
    await client.connect();
    return null;
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    // "Connection closed" alone names nothing; the host is the useful part.
    return `${why} (${new URL(url).host})`;
  } finally {
    await client.close().catch(() => undefined);
  }
};
