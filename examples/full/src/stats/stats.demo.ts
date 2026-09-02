import { EventLoopLag, Logger } from '@dunx/core';
import { RequestMetrics } from '@dunx/http';
import { QueryMetrics } from '@dunx/infra/db';

/** Read out of the same container, from work the tour already did. */
export class StatsDemo {
  constructor(
    private readonly logger: Logger,
    private readonly requests: RequestMetrics,
    private readonly queries: QueryMetrics,
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

    const loop = this.lag.snapshot();
    this.logger.info(
      `event loop lag: ${loop.count} samples, p99 ${ms(loop.p99)} ` +
        `max ${ms(loop.max)}`,
    );
  }
}
