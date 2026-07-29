import { Module } from '@dunx/core';
import { RedisModule } from '@dunx/infra/redis';
import { Sessions } from './sessions.service.js';

@Module({
  imports: [
    // No url: Bun's own chain decides it — $VALKEY_URL, then $REDIS_URL, then
    // valkey://localhost:6379. Connections are lazy, so nothing is dialled here
    // and an unavailable cache cannot stop the process from booting. `eager: true`
    // would opt into finding out at startup, which is the opposite of the point.
    //
    // `maxRetries: 0` is not just impatience: measured on Bun 1.3.14, a client
    // that failed to connect with `maxRetries > 0` keeps a retry timer alive even
    // after `close()`, and the process never exits. With 0 it exits cleanly.
    RedisModule.forRoot({ connectionTimeout: 500, maxRetries: 0 }),
  ],
  providers: [Sessions],
})
export class CacheModule {}
