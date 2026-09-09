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
import { answerIo } from '../io/respond.js';
import { port } from '../shared.js';
import { DriverPair } from './pair.js';

const pair = await DriverPair.connect('pg', 'ioredis');

const TEXT = { 'content-type': 'text/plain; charset=utf-8' };

createServer((req, res) => {
  if (req.url === '/io') {
    // `answerIo`, not a bare `.then`: this file is where that shape was written
    // the second time. See servers/io/respond.ts.
    answerIo(res, () => pair.read());
    return;
  }
  res.writeHead(200, TEXT);
  res.end('Hello, World!');
}).listen(port());
