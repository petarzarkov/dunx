import {
  DatabaseIndicator,
  DiskIndicator,
  DiskOptions,
  HealthIndicator,
  MemoryIndicator,
  MemoryOptions,
  RedisIndicator,
  type ProbeResult,
} from '@dunx/http';
import type { DbConnection } from '@dunx/infra/db';
import type { RedisConnection } from '@dunx/infra/redis';
import { Ledger } from '../database/ledger.service.js';

/** A custom indicator: `DatabaseIndicator` asks whether the connection answers,
 * this asks whether the data is there. */
export class LedgerIndicator extends HealthIndicator {
  readonly name = 'ledger';

  constructor(private readonly ledger: Ledger) {
    super();
  }

  check(): ProbeResult {
    const rows = this.ledger.rows();
    return rows > 0
      ? {
          state: 'up',
          detail: `${rows} rows, balance ${this.ledger.balance()}`,
        }
      : { state: 'down', detail: 'no rows - the seeds did not run' };
  }
}

/**
 * `RedisIndicator` with the criticality flipped: a missing cache is degraded
 * rather than fatal, matching `CacheModule`'s lazy connect and `maxRetries: 0`.
 */
export class CacheIndicator extends RedisIndicator {
  override readonly critical = false;
}

export interface AppIndicatorsInit {
  readonly db: DbConnection;
  readonly redis: RedisConnection;
  readonly ledger: Ledger;
  /** Where uploads land, so a full disk here is a real failure. */
  readonly uploadRoot: string;
}

/**
 * One declaration of what this service probes, read by both `HealthModule` and
 * `DashboardModule`. A `HealthIndicator` satisfies `DashboardProbe` as written.
 */
export class AppIndicators {
  readonly readiness: readonly HealthIndicator[];
  readonly liveness: readonly HealthIndicator[];
  /** Minus what the dashboard sources itself: `DashboardOptions.redis` already
   * drives a `redis` probe, so `CacheIndicator` here would light it twice. */
  readonly dashboardProbes: readonly HealthIndicator[];

  constructor(init: AppIndicatorsInit) {
    this.readiness = [
      new DatabaseIndicator(init.db),
      new LedgerIndicator(init.ledger),
      new CacheIndicator(init.redis),
      new DiskIndicator(
        new DiskOptions({ path: init.uploadRoot, maxUsedFraction: 0.95 }),
      ),
    ];
    // A ceiling belongs on liveness, where the orchestrator restarts rather
    // than routes around.
    this.liveness = [
      new MemoryIndicator(
        new MemoryOptions({ maxRssBytes: 1024 * 1024 * 1024 }),
      ),
    ];
    this.dashboardProbes = this.readiness.filter(
      (indicator) => !(indicator instanceof CacheIndicator),
    );
  }
}
