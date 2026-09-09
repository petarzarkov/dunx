/**
 * The `io` scenario on Bun's own clients: `Bun.SQL` for Postgres and
 * `Bun.RedisClient` for Redis, both native and neither a JavaScript protocol
 * implementation.
 *
 * `servers/io/node.ts` is the same two round trips through `pg` and `ioredis`.
 * The pair is the whole point of the scenario, and `src/drivers.ts` runs both of
 * them on Bun so the runtime term drops out of the comparison.
 */
import { RedisClient, SQL } from 'bun';
import {
  IO_POOL_SIZE,
  IO_REDIS_KEY,
  IO_ROW_ID,
  IO_SELECT,
  type IoRow,
  ioPayload,
  type IoPayload,
  pgUrl,
  redisUrl,
} from './contract.js';

export class BunIo {
  private readonly sql = new SQL({ url: pgUrl(), max: IO_POOL_SIZE });
  private readonly redis = new RedisClient(redisUrl());

  async read(): Promise<IoPayload> {
    const cached = await this.redis.get(IO_REDIS_KEY);
    const rows = (await this.sql.unsafe(IO_SELECT, [IO_ROW_ID])) as IoRow[];
    return ioPayload(cached, rows[0]);
  }

  /**
   * Both clients connect lazily, so a handler would otherwise pay the connect on
   * whichever request arrived first. Called before `listen()`, which puts it in
   * the startup number where it belongs.
   */
  async ready(): Promise<void> {
    await this.read();
  }
}

let client: BunIo | null = null;

/**
 * Reached through `await import()` from each server file, never a top-level
 * import, so a scenario that is not `io` opens no socket and pays no module load.
 */
export const connectBunIo = async (): Promise<void> => {
  client = new BunIo();
  await client.ready();
};

export const readBunIo = (): Promise<IoPayload> => {
  if (client === null) {
    throw new Error('io is not connected: BENCH_IO_PG_URL is unset');
  }
  return client.read();
};
