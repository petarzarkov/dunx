/**
 * The `io` scenario on the two clients a Node service reaches for: `pg` and
 * `ioredis`. Both are JavaScript implementations of a wire protocol Bun ships
 * natively, which is exactly what makes them the comparison - see
 * `servers/io/bun.ts` and `src/drivers.ts`.
 *
 * `pg` is given the same pool size as every other subject. `ioredis` opens one
 * connection, as `Bun.RedisClient`, `StackExchange.Redis`, Lettuce and redis-rs
 * all do - but **it does not batch**: `enableAutoPipelining` defaults to `false`
 * in ioredis 6.0.0, where `Bun.RedisClient` pipelines a tick's commands into one
 * write. Both are left at their defaults, the way every other subject here is,
 * and the asymmetry is recorded in the subject registry rather than tuned away.
 */
import { Redis } from 'ioredis';
import { Pool } from 'pg';
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

// Loaded through `servers/io/lazy.ts`, never imported at a server's top level:
// `pg` and `ioredis` are real module loads, and a static import would put them in
// every scenario's startup number rather than only the `io` one.

export class NodeIo {
  private readonly pool = new Pool({
    connectionString: pgUrl(),
    max: IO_POOL_SIZE,
  });

  private readonly redis = new Redis(redisUrl());

  async read(): Promise<IoPayload> {
    const cached = await this.redis.get(IO_REDIS_KEY);
    const result = await this.pool.query<IoRow>(IO_SELECT, [IO_ROW_ID]);
    return ioPayload(cached, result.rows[0]);
  }

  async ready(): Promise<void> {
    await this.read();
  }
}
