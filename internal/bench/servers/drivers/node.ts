/**
 * The driver harness's server on Node: `node:http`, the same one route, and `pg`
 * plus `ioredis` - the only pair Node can run, since `Bun.SQL` and
 * `Bun.RedisClient` are builtins of the other runtime.
 *
 * This cell differs from `bun:classic` in the runtime **and** the server, so it
 * is the "what a Node service does" reference point rather than a driver
 * comparison. The driver comparison is the four Bun cells, where the runtime is
 * held still.
 */
import { createServer } from 'node:http';
import { port } from '../shared.js';
import { DriverPair } from './pair.js';

const pair = await DriverPair.connect('pg', 'ioredis');

const TEXT = { 'content-type': 'text/plain; charset=utf-8' };
const JSON_TYPE = { 'content-type': 'application/json; charset=utf-8' };

createServer((req, res) => {
  if (req.url === '/io') {
    // The rejection is handled rather than left to Node's default, which exits
    // the process. `servers/node-http.ts` carries the same branch and the same
    // reason: a pool that cannot hand out a connection took a subject down
    // mid-run once, and the harness recorded the connection failures as 560,964
    // req/s. This file is the sibling that kept the bug.
    void pair.read().then(
      (payload) => {
        res.writeHead(200, JSON_TYPE);
        res.end(JSON.stringify(payload));
      },
      (error: unknown) => {
        res.writeHead(500, JSON_TYPE);
        res.end(JSON.stringify({ error: String(error) }));
      },
    );
    return;
  }
  res.writeHead(200, TEXT);
  res.end('Hello, World!');
}).listen(port());
