import { EventLoopLag, Module } from '@dunx/core';
import { DatabaseModule } from '../database/database.module.js';
import { StatsDemo } from './stats.demo.js';

/**
 * `RequestMetrics` is global, so only `QueryMetrics` is imported. `EventLoopLag`
 * is a provider so its `onInit` enables it at boot rather than at read time.
 */
@Module({
  imports: [DatabaseModule],
  providers: [EventLoopLag, StatsDemo],
  /** `EventLoopLag` is exported rather than provided a second time: a module
   * that provides it again gets its own instance and its own `onInit`. */
  exports: [StatsDemo, EventLoopLag],
})
export class StatsModule {}
