import { Controller, Get, Public, UseGuards } from '@dunx/http';
import { ApiKeyGuard } from './api-key.guard.js';

@UseGuards(ApiKeyGuard)
@Controller('reports')
export class ReportsController {
  /** The guard reads this and skips, so the liveness probe needs no key. */
  @Public()
  @Get('/health')
  health(): { ok: true } {
    return { ok: true };
  }

  @Get('/')
  list(): readonly string[] {
    return ['q1-revenue', 'q2-revenue'];
  }
}
