import { Controller, Get, Public } from '@dunx/http';
import { Storage } from '@dunx/infra/files';
import { Sessions } from '../cache/sessions.service.js';
import { AppConfigService } from '../config.js';
import { Ledger } from '../database/ledger.service.js';

export interface AreaStatus {
  readonly name: string;
  readonly state: 'live' | 'degraded';
  readonly detail: string;
}

/**
 * What is actually working right now. Redis is the only area that can be down
 * without stopping the app, so it is the only one that ever reports `degraded` -
 * everything else is in-process and either booted or the app did not.
 */
@Controller('health')
export class HealthController {
  constructor(
    private readonly config: AppConfigService,
    private readonly ledger: Ledger,
    private readonly storage: Storage,
    private readonly sessions: Sessions,
  ) {}

  @Public()
  @Get('/', {})
  async status(): Promise<{
    ok: boolean;
    app: string;
    areas: readonly AreaStatus[];
  }> {
    const areas = await this.areas();
    return {
      ok: true,
      app: this.config.get('appName'),
      areas,
    };
  }

  async areas(): Promise<readonly AreaStatus[]> {
    const cache = await this.sessions.status();
    return [
      {
        name: '@dunx/infra/db',
        state: 'live',
        detail: `${this.ledger.rows()} ledger rows, balance ${this.ledger.balance()}`,
      },
      {
        name: '@dunx/infra/files',
        state: 'live',
        detail: `${this.storage.constructor.name} ready`,
      },
      { name: '@dunx/infra/images', state: 'live', detail: 'Bun.Image ready' },
      {
        name: '@dunx/infra/redis',
        state: cache.reachable ? 'live' : 'degraded',
        detail: cache.reachable
          ? `reachable at ${cache.url}`
          : (cache.note ?? `unreachable at ${cache.url}`),
      },
    ];
  }
}
