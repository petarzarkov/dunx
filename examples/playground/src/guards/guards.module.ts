import { Module } from '@dunx/core';
import { DocsModule } from '../docs/docs.module.js';
import { AuthGuard, RolesGuard } from './auth.guard.js';
import { GuardsDemo } from './guards.demo.js';
import { ReportsController } from './reports.controller.js';
import { ReportsService } from './reports.service.js';

/**
 * Its own app in `main.ts`: a global auth guard challenges *every* route, and the
 * rest of the tour deliberately sends no credentials.
 */
@Module({
  imports: [DocsModule],
  controllers: [ReportsController],
  providers: [ReportsService, AuthGuard, RolesGuard, GuardsDemo],
})
export class GuardsModule {}
