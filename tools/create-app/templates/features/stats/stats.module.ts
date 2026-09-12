import { EventLoopLag, Module } from '@dunx/core';
import { CacheModule } from '../cache/cache.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { JobsModule } from '../jobs/jobs.module.js';
import { StatsDemo } from './stats.demo.js';

/**
 * `RequestMetrics` is global; the other four are bound by the module that owns
 * what they measure, so all three modules are imported. `EventLoopLag` is a
 * provider so its `onInit` enables it at boot rather than at read time.
 */
@Module({
  imports: [DatabaseModule, CacheModule, JobsModule],
  providers: [EventLoopLag, StatsDemo],
  /** `EventLoopLag` is exported rather than provided a second time: a module
   * that provides it again gets its own instance and its own `onInit`. */
  exports: [StatsDemo, EventLoopLag],
})
export class StatsModule {}
