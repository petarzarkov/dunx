import { RedisModule } from '@dunx/infra/redis';
import { AppConfigService } from '../config.js';

/**
 * Its own file because three modules name it, and a dynamic module is its own
 * scope keyed on the reference: calling `forRootAsync` again opens a second
 * connection. No url, so Bun resolves $VALKEY_URL, $REDIS_URL, then localhost.
 * `maxRetries: 0` because a failed connect with retries outlives `close()`.
 */
export const appRedis = RedisModule.forRootAsync(
  {
    useFactory: (config: AppConfigService) => {
      // `exactOptionalPropertyTypes` will not let `string | undefined` reach
      // a `url?: string`, even where `undefined` is ruled out.
      const { url } = config.get('redis');
      return {
        ...(url === undefined ? {} : { url }),
        connectionTimeout: 500,
        maxRetries: 0,
      };
    },
    inject: [AppConfigService] as const,
  },
  // No subclass: the default connection. Settings come last, as on `DbModule`.
  undefined,
  // Times every command, readable as `RedisMetrics`. Off by default.
  { metrics: true },
);
