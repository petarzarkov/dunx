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

/**
 * The custom-indicator path: an app-specific query rather than a round trip.
 *
 * `DatabaseIndicator` answers "does the connection answer". This answers "is the
 * data there", which is the part only the app knows how to ask.
 */
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
 * `RedisIndicator` with the criticality flipped, because this app treats a missing
 * cache as degraded rather than fatal - the same promise `CacheModule` makes with
 * lazy connections and `maxRetries: 0`.
 *
 * Shedding traffic here would be wrong: the routes that need Redis report
 * themselves degraded and every other route still works.
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
 * The one declaration of what this service probes.
 *
 * It is a provider rather than two lists inlined into two factories because two
 * things read it: `HealthModule` answers `/api/health/ready`, and
 * `DashboardModule` lights the same checks on the ops page. A `HealthIndicator`
 * satisfies `DashboardProbe` as written, so neither side needs an adapter.
 */
export class AppIndicators {
  readonly readiness: readonly HealthIndicator[];
  readonly liveness: readonly HealthIndicator[];
  /**
   * The readiness list minus what the dashboard already sources itself:
   * `DashboardOptions.redis` drives the Redis panel *and* a `redis` probe, so
   * handing it `CacheIndicator` as well would light the same name twice.
   */
  readonly dashboardProbes: readonly HealthIndicator[];

  constructor(init: AppIndicatorsInit) {
    this.readiness = [
      new DatabaseIndicator(init.db),
      new LedgerIndicator(init.ledger),
      new CacheIndicator(init.redis),
      // Non-critical, because no other pod's disk is any emptier.
      new DiskIndicator(
        new DiskOptions({ path: init.uploadRoot, maxUsedFraction: 0.95 }),
      ),
    ];
    // A ceiling belongs on liveness, where the orchestrator restarts the process
    // rather than routing around it.
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
