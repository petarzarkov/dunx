import { Module } from '@dunx/core';
import { CacheModule } from '../cache/cache.module.js';
import { DatabaseModule } from '../database/database.module.js';
import { StorageModule } from '../storage/storage.module.js';
import { HealthController } from './health.controller.js';

// A health check is the module that imports the most: it reports on every area, so it
// needs each one's public surface. That is the boundary doing its job - the imports
// list is now an accurate statement of what this feature touches.
@Module({
  imports: [DatabaseModule, CacheModule, StorageModule],
  controllers: [HealthController],
})
export class HealthModule {}
