import {
  isConnectionError,
  RedisConnection,
  RedisOptions,
} from '@dunx/infra/redis';
import { Logger } from '../logger.js';

export class Sessions {
  // Namespaced by pid so a run cannot read another run's keys, and both are
  // deleted before this returns.
  readonly #session = `playground:${process.pid}:session`;
  readonly #visits = `playground:${process.pid}:visits`;

  constructor(
    private readonly redis: RedisConnection,
    private readonly options: RedisOptions,
    private readonly logger: Logger,
  ) {}

  async demonstrate(): Promise<void> {
    const { redis, logger } = this;

    try {
      logger.info(`PING ${this.options.url} -> ${await redis.ping()}`);

      // SET takes an options object rather than Bun's positional overloads.
      await redis.set(this.#session, JSON.stringify({ user: 'ada' }), {
        ex: 60,
      });
      logger.info(
        `SET/GET session -> ${await redis.get(this.#session)}, ` +
          `ttl ${await redis.ttl(this.#session)}s`,
      );
      logger.info(`INCR visits -> ${await redis.incr(this.#visits)}`);
      logger.info(
        `DEL -> ${await redis.del(this.#session, this.#visits)} keys removed`,
      );
    } catch (error) {
      // Bun raises some of these synchronously, so the wrapper catches around
      // the call and a caller only ever sees a rejection.
      if (!isConnectionError(error)) throw error;
      logger.info(
        `skipping redis at ${this.options.url}: ${(error as Error).message}`,
      );
      logger.info('a cache that is not running must not fail the app');
    }
  }
}
