import { EventLoopLag, Logger } from '@dunx/core';
import { RequestMetrics } from '@dunx/http';
import { CacheMetrics } from '@dunx/infra/cache';
import { QueryMetrics } from '@dunx/infra/db';
import { QueueMetrics } from '@dunx/infra/queue';
import { RedisMetrics } from '@dunx/infra/redis';

/** Read out of the same container, from work the tour already did. */
export class StatsDemo {
  constructor(
    private readonly logger: Logger,
    private readonly requests: RequestMetrics,
    private readonly queries: QueryMetrics,
    private readonly cache: CacheMetrics,
    private readonly commands: RedisMetrics,
    private readonly jobs: QueueMetrics,
    private readonly lag: EventLoopLag,
  ) {}

  demonstrate(): void {
    const http = this.requests.snapshot();
    const ms = (nanoseconds: number | undefined): string =>
      nanoseconds === undefined ? '-' : `${(nanoseconds / 1e6).toFixed(2)}ms`;

    this.logger.info(
      `${http.routes.length} route series, ${http.inFlight} in flight, ` +
        `${http.pendingWebSockets} sockets - both read off Bun.serve, not counted`,
    );

    const slowest = [...http.routes]
      .sort((a, b) => (b.duration.p99 ?? 0) - (a.duration.p99 ?? 0))
      .slice(0, 3);
    for (const route of slowest) {
      this.logger.info(
        `${route.method} ${route.route}: ${route.count} calls, ` +
          `p50 ${ms(route.duration.p50)} p99 ${ms(route.duration.p99)} ` +
          `max ${ms(route.duration.max)}`,
      );
    }

    const worst = slowest[0];
    if (worst?.slowestTraceId !== undefined) {
      this.logger.info(
        `the slowest ${worst.route} call has traceId ${worst.slowestTraceId} - ` +
          'every line that request wrote carries it',
      );
    }

    const unmatched = http.routes.find(
      (route) => route.route === '(unmatched)',
    );
    this.logger.info(
      `unmatched paths: ${unmatched?.count ?? 0} across one series, so a ` +
        'scanner walking urls cannot grow the series count',
    );

    const db = this.queries.snapshot();
    this.logger.info(
      `${db.total} queries, timed at the bun:sqlite handle dunx constructs - ` +
        "drizzle's own logQuery fires before the statement runs and cannot time one",
    );
    for (const operation of db.operations) {
      this.logger.info(
        `${operation.operation}: ${operation.count} calls, ` +
          `${operation.errors} failed, p99 ${ms(operation.duration.p99)}`,
      );
    }

    const cache = this.cache.snapshot();
    this.logger.info(
      `cache: ${cache.hits} hits, ${cache.misses} misses, ` +
        `hit rate ${(cache.hitRate * 100).toFixed(1)}% over ${cache.total} operations`,
    );
    for (const operation of cache.operations) {
      this.logger.info(
        `${operation.operation}: ${operation.count} calls, ` +
          `${operation.errors} failed, p99 ${ms(operation.duration.p99)}`,
      );
    }
    this.logger.info(
      'recorded at the CacheStore seam, so a tiered L2 hit promoted into L1 is ' +
        'one get and one hit - and the key is never kept',
    );

    const redis = this.commands.snapshot();
    this.logger.info(
      `${redis.total} redis commands across ${redis.commands.length} verbs, ` +
        `${redis.errors} failed - timed at the one seam every command goes through`,
    );
    const busiest = [...redis.commands]
      .sort((a, b) => b.count - a.count)
      .slice(0, 3);
    for (const command of busiest) {
      this.logger.info(
        `${command.command}: ${command.count} calls, ` +
          `p99 ${ms(command.duration.p99)} - the key is never kept`,
      );
    }

    const queue = this.jobs.snapshot();
    this.logger.info(
      `${queue.published} jobs published, ${queue.handled} handled in this process`,
    );
    for (const entry of queue.jobs) {
      this.logger.info(
        `${entry.queue}/${entry.name}: published ${entry.published} ` +
          `(p99 ${ms(entry.publishDuration.p99)}), handled ${entry.handled} ` +
          `(p99 ${ms(entry.handlerDuration.p99)})`,
      );
    }
    this.logger.info(
      'a background handler runs in a forked child with its own container, so ' +
        'its duration is 0 here and the publish beside it is not',
    );

    const loop = this.lag.snapshot();
    this.logger.info(
      `event loop lag: ${loop.count} samples, p99 ${ms(loop.p99)} ` +
        `max ${ms(loop.max)}`,
    );
  }
}
