import { Module } from '@dunx/core';
import { RedisModule } from '@dunx/redis';
import { LeaderboardService } from './leaderboard.service.js';
import { NotificationsService } from './notifications.service.js';
import { SessionsService } from './sessions.service.js';

@Module({
  imports: [
    // Retries off and a short timeout so an absent server fails in about a
    // millisecond instead of sitting in the offline queue. The queue itself stays
    // on, which is what lets a command connect lazily when the server is there.
    RedisModule.forRoot({
      url: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
      connectionTimeout: 1000,
      autoReconnect: false,
      maxRetries: 0,
    }),
  ],
  providers: [LeaderboardService, NotificationsService, SessionsService],
})
export class AppModule {}
