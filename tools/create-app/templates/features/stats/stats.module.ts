import { EventLoopLag, Module } from '@dunx/core';
import { DatabaseModule } from '../database/database.module.js';
import { StatsDemo } from './stats.demo.js';

/**
 * `RequestMetrics` is bound app-wide by `HttpFactory`'s global wrapper, so only
 * `QueryMetrics` has to be imported - `DatabaseModule` re-exports it.
 *
 * `EventLoopLag` is a provider so its `onInit` runs at boot. Enabling it at read
 * time would miss a block in the same event-loop turn as `enable()`.
 */
@Module({
  imports: [DatabaseModule],
  providers: [EventLoopLag, StatsDemo],
  exports: [StatsDemo],
})
export class StatsModule {}
