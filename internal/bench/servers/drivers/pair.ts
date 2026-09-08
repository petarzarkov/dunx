/**
 * One Redis client and one Postgres client, chosen by environment, doing the
 * `io` scenario's two round trips.
 *
 * This is what `bun run drivers` varies and nothing else: the server, the
 * runtime, the SQL, the pool size and the bytes on the wire are all held still,
 * so the difference between two cells is the driver.
 *
 * Every client is loaded with `await import()`. A cell running `Bun.SQL` must not
 * pay for `pg` being on disk, and the Node build has no `Bun` to import at all.
 */
import {
  IO_POOL_SIZE,
  IO_REDIS_KEY,
  IO_ROW_ID,
  IO_SELECT,
  ioPayload,
  type IoPayload,
  pgUrl,
  redisUrl,
} from '../io/contract.js';

export type SqlKind = 'bun' | 'pg';
export type RedisKind = 'bun' | 'ioredis';

interface Row {
  id: number;
  memo: string;
  amount: number;
}

type ReadCache = () => Promise<string | null>;
type ReadRow = () => Promise<Row | undefined>;

const bunRedis = async (): Promise<ReadCache> => {
  const { RedisClient } = await import('bun');
  const client = new RedisClient(redisUrl());
  return () => client.get(IO_REDIS_KEY);
};

const ioredis = async (): Promise<ReadCache> => {
  const { Redis } = await import('ioredis');
  const client = new Redis(redisUrl());
  return () => client.get(IO_REDIS_KEY);
};

const bunSql = async (): Promise<ReadRow> => {
  const { SQL } = await import('bun');
  const sql = new SQL({ url: pgUrl(), max: IO_POOL_SIZE });
  return async () => ((await sql.unsafe(IO_SELECT, [IO_ROW_ID])) as Row[])[0];
};

const pg = async (): Promise<ReadRow> => {
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: pgUrl(), max: IO_POOL_SIZE });
  return async () => (await pool.query<Row>(IO_SELECT, [IO_ROW_ID])).rows[0];
};

export class DriverPair {
  private constructor(
    private readonly cache: ReadCache,
    private readonly row: ReadRow,
  ) {}

  static async connect(sql: SqlKind, redis: RedisKind): Promise<DriverPair> {
    const pair = new DriverPair(
      await (redis === 'bun' ? bunRedis() : ioredis()),
      await (sql === 'bun' ? bunSql() : pg()),
    );
    // Every client here connects lazily, so one round trip before `listen()`
    // keeps the connect out of the measured window.
    await pair.read();
    return pair;
  }

  async read(): Promise<IoPayload> {
    return ioPayload(await this.cache(), await this.row());
  }
}

export const chosen = (): { sql: SqlKind; redis: RedisKind } => ({
  sql: process.env['BENCH_DRIVER_SQL'] === 'pg' ? 'pg' : 'bun',
  redis: process.env['BENCH_DRIVER_REDIS'] === 'ioredis' ? 'ioredis' : 'bun',
});
