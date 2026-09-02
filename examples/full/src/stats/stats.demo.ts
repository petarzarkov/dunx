import { EventLoopLag, Logger } from '@dunx/core';
import { RequestMetrics } from '@dunx/http';
import { QueryMetrics } from '@dunx/infra/db';

/**
 * What `metrics: true` costs and what it buys, read out of the same container
 * the app served every other section of this tour from.
 *
 * Nothing here generates traffic: every request and every query the tour already
 * made is in these numbers, which is the point - the counters are a by-product of
 * work the app was doing anyway.
 */
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

    // Slowest first, which is the only order worth printing.
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

    // The exemplar: which request was the slow one, and where its log lines are.
    const worst = slowest[0];
    if (worst?.slowestTraceId !== undefined) {
      this.logger.info(
        `the slowest ${worst.route} call has traceId ${worst.slowestTraceId} - ` +
          'every line that request wrote carries it',
      );
    }

    // One series per route **pattern**: /api/users/:id is one row however many
    // ids were fetched, and every unmatched path collapses into `(unmatched)`.
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

    // Sampled since onInit, on `monitorEventLoopDelay`. Nothing in this tour
    // blocks, so the interesting number is that it is small.
    const loop = this.lag.snapshot();
    this.logger.info(
      `event loop lag: ${loop.count} samples, p99 ${ms(loop.p99)} ` +
        `max ${ms(loop.max)}`,
    );
  }
}
