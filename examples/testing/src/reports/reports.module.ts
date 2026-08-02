import { Module } from '@dunx/core';
import { ApiKeyGuard } from './api-key.guard.js';
import { ApiKeys } from './api-keys.js';
import { ReportsController } from './reports.controller.js';

@Module({
  controllers: [ReportsController],
  providers: [ApiKeys, ApiKeyGuard],
})
export class ReportsModule {}
