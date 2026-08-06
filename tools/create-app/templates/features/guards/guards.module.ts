import { Module } from '@dunx/core';
import { AuthGuard, RolesGuard } from './auth.guard.js';
import { GuardsDemo } from './guards.demo.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/**
 * Part of the one app, not its own. `AuthGuard` is applied by
 * `@UseGuards(AuthGuard)` on `ReportsController` rather than as global
 * middleware, so it challenges `/api/reports` and nothing else.
 */
@Module({
  controllers: [ReportsController],
  providers: [ReportsService, AuthGuard, RolesGuard, GuardsDemo],
  exports: [AuthGuard, RolesGuard, GuardsDemo],
})
export class GuardsModule {}
