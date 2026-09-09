/**
 * Answering `/io` from a raw `node:http` handler, without a way to forget the
 * rejection.
 *
 * This exists because the same bug was written twice. `servers/node-http.ts` had
 * a bare `.then(success)` on the io read, so a pool that could not hand out a
 * connection produced an unhandled rejection, Node exited, and the harness
 * recorded the resulting connection failures as 560,964 req/s - above raw
 * `Bun.serve`. It was fixed there and left in `servers/drivers/node.ts`, which is
 * the same file with a different client behind it.
 *
 * The frameworks do not need this: Express 5, Fastify, Hono and Nest all turn a
 * rejected handler promise into a 5xx themselves. A raw `createServer` callback
 * is the one place where forgetting is fatal, and there are two of them.
 */
import type { ServerResponse } from 'node:http';

const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };

/**
 * Never rejects, and never leaves the response open. A failure answers 500 the
 * way every framework subject does, so the load generator records an HTTP error
 * rather than waiting out its timeout.
 */
export const answerIo = (
  res: ServerResponse,
  read: () => Promise<unknown>,
): void => {
  void read().then(
    (payload) => {
      res.writeHead(200, JSON_TYPE);
      res.end(JSON.stringify(payload));
    },
    (error: unknown) => {
      res.writeHead(500, JSON_TYPE);
      res.end(JSON.stringify({ error: String(error) }));
    },
  );
};
