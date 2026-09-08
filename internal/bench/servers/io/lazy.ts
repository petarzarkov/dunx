/**
 * The Node subjects' way in to `servers/io/node.ts`, which they must not import
 * at their top level.
 *
 * `pg` and `ioredis` are third-party module loads worth tens of milliseconds, and
 * a subject spawns fresh per scenario - so a static import would charge every
 * scenario's startup number for a client only the `io` scenario uses. The Bun
 * subjects have no equivalent, because `Bun.SQL` and `Bun.RedisClient` are
 * builtins and importing them costs nothing.
 *
 * The indirection also gives the Nest controller something to call: its routes are
 * read off the class at boot, so it cannot hold the dynamically imported reader
 * itself.
 */
import { type IoPayload, ioEnabled } from './contract.js';

let reader: (() => Promise<IoPayload>) | null = null;

/** `true` when the scenario is on and the clients answered, so the caller can
 * register the route only when there is something behind it. */
export const connectLazyIo = async (): Promise<boolean> => {
  if (!ioEnabled()) return false;
  const module = await import('./node.js');
  const client = new module.NodeIo();
  await client.ready();
  reader = () => client.read();
  return true;
};

export const readLazyIo = (): Promise<IoPayload> => {
  if (reader === null) {
    throw new Error('io is not connected: BENCH_IO_PG_URL is unset');
  }
  return reader();
};
