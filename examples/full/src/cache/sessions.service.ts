import { Logger } from '@dunx/core';
import { isConnectionError, RedisOptions } from '@dunx/infra/redis';
import { SessionsRedis } from './sessions.redis.js';

export class Sessions {
  // Namespaced by pid so one run cannot read another run's keys.
  readonly #prefix = `dunx-full:${process.pid}`;

  constructor(
    // The subclass, not `RedisConnection`: a named connection is a parameter
    // type now, so this needs no `inject()` in a field.
    private readonly redis: SessionsRedis,
    private readonly options: RedisOptions,
    private readonly logger: Logger,
  ) {}

  /** Whether a thrown value means "the cache is down" rather than "the call was wrong". */
  isDown(error: unknown): boolean {
    return isConnectionError(error);
  }

  async status(): Promise<{ url: string; reachable: boolean; note?: string }> {
    try {
      await this.redis.ping();
      return { url: this.options.url, reachable: true };
    } catch (error) {
      if (!this.isDown(error)) throw error;
      return {
        url: this.options.url,
        reachable: false,
        note: `${(error as Error).message}. A cache that is not running must not fail the app.`,
      };
    }
  }

  async read(
    id: string,
  ): Promise<{ id: string; data: unknown; ttl: number } | null> {
    const key = this.#key(id);
    const raw = await this.redis.get(key);
    if (raw === null) return null;
    return { id, data: JSON.parse(raw), ttl: await this.redis.ttl(key) };
  }

  /** SET takes an options object rather than Bun's positional overloads. */
  async store(
    id: string,
    data: Record<string, unknown>,
    ttl: number,
  ): Promise<{ id: string; ttl: number; visits: number }> {
    await this.redis.set(this.#key(id), JSON.stringify(data), { ex: ttl });
    const visits = await this.redis.incr(`${this.#prefix}:visits`);
    return { id, ttl, visits };
  }

  async remove(id: string): Promise<{ removed: number }> {
    return { removed: await this.redis.del(this.#key(id)) };
  }

  async demonstrate(): Promise<void> {
    const { redis, logger } = this;
    const session = this.#key('demo');
    const visits = `${this.#prefix}:visits`;

    try {
      logger.info(`PING ${this.options.url} -> ${await redis.ping()}`);

      await redis.set(session, JSON.stringify({ user: 'ada' }), { ex: 60 });
      logger.info(
        `SET/GET session -> ${await redis.get(session)}, ` +
          `ttl ${await redis.ttl(session)}s`,
      );
      logger.info(`INCR visits -> ${await redis.incr(visits)}`);
      logger.info(`DEL -> ${await redis.del(session, visits)} keys removed`);
    } catch (error) {
      // Bun raises some of these synchronously, so the wrapper catches around
      // the call and a caller only ever sees a rejection.
      if (!this.isDown(error)) throw error;
      logger.warn(
        `skipping redis at ${this.options.url}: ${(error as Error).message}`,
      );
      logger.info('a cache that is not running must not fail the app');
    }
  }

  #key(id: string): string {
    return `${this.#prefix}:session:${id}`;
  }
}
