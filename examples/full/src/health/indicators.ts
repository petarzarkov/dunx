import {
  AmqpIndicator,
  DatabaseIndicator,
  DiskIndicator,
  DiskOptions,
  HealthIndicator,
  MemoryIndicator,
  MemoryOptions,
  RedisIndicator,
  StorageIndicator,
  type ProbeResult,
} from '@dunx/http';
import type { DegradingCacheStore } from '@dunx/infra/cache';
import type { DbConnection } from '@dunx/infra/db';
import type { Storage } from '@dunx/infra/files';
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
    const balance = this.ledger.balance();
    // The line is for whoever opens the page, `data` for whatever scrapes it.
    return rows > 0
      ? {
          state: 'up',
          detail: `${rows} rows, balance ${balance}`,
          data: { rows, balance },
        }
      : { state: 'down', detail: 'no rows - the seeds did not run' };
  }
}

/**
 * Whether the shared cache tier is answering, asked rather than remembered:
 * `degraded` is only what the last call set. Not critical - it degrades.
 */
export class CacheStoreIndicator extends HealthIndicator {
  readonly name = 'cache';
  override readonly critical = false;

  constructor(private readonly store: DegradingCacheStore) {
    super();
  }

  async check(): Promise<ProbeResult> {
    const started = performance.now();
    const reachable = await this.store.probe();
    const roundTripMs = Math.round(performance.now() - started);

    return reachable
      ? { state: 'up', detail: `${roundTripMs} ms`, data: { roundTripMs } }
      : {
          state: 'down',
          detail: 'unreachable - reads are answering as misses',
          data: { roundTripMs, degraded: true },
        };
  }
}

/**
 * `RedisIndicator` with the criticality flipped: a missing cache is degraded
 * rather than fatal, matching `CacheModule`'s lazy connect and `maxRetries: 0`.
 */
export class CacheIndicator extends RedisIndicator {
  override readonly critical = false;
}

/** The same flip: a demo that 503s without RabbitMQ is a demo nobody can run.
 * `ProbesModule` holds it, since `AmqpConnection` comes from a consuming module. */
export class BrokerIndicator extends AmqpIndicator {
  override readonly critical = false;
}

export interface AppIndicatorsInit {
  readonly db: DbConnection;
  readonly redis: RedisConnection;
  /** The degrading L2, so the cache is probed rather than assumed. */
  readonly cache: DegradingCacheStore;
  readonly ledger: Ledger;
  readonly storage: Storage;
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
      new CacheStoreIndicator(init.cache),
      new StorageIndicator(init.storage),
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
