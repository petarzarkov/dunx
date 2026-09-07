import type { HttpStatsReport } from '@dunx/http';
import { OPS } from './ops.js';
import type { OpStats } from './workload.js';

export interface BudgetLimits {
  /**
   * The least share of an op's answered calls that must be work rather than a
   * refusal. Under this the run is measuring the rate limiter.
   */
  readonly minWorkShare: number;
  readonly minCallsPerSecond: number;
  /** Per route, from the server's own histogram. */
  readonly maxP99Ms: number;
  readonly maxSingleRequestMs: number;
}

/**
 * Generous on purpose. These catch a route that went from 4 ms to 5 s, not a
 * regression of a few hundred microseconds: a shared CI runner moves the numbers
 * far more than most changes do, and a tight budget here would fail on the
 * machine rather than on the code.
 */
export const DEFAULT_LIMITS: BudgetLimits = {
  minWorkShare: 0.9,
  minCallsPerSecond: 200,
  maxP99Ms: 250,
  maxSingleRequestMs: 5000,
};

export interface BudgetInput {
  readonly stats: ReadonlyMap<string, OpStats>;
  readonly elapsedSeconds: number;
  /** Absent for a phase judged on op outcomes alone, such as recovery. */
  readonly metrics?: HttpStatsReport;
  /** Ops needing the broker are not floored when nothing is answering. */
  readonly redisUp: boolean;
}

export interface BudgetResult {
  readonly failures: readonly string[];
  readonly report: readonly string[];
}

const NS_PER_MS = 1_000_000;

/**
 * Judges a load run from two sides: what the client saw, and what the server's
 * own `RequestMetrics` recorded.
 *
 * The server side is the half that was missing. A client-side accept-set answers
 * "did anything throw", where the histogram answers "what did each route
 * actually cost and what did it answer", which is the question a load test is
 * for.
 */
export class LoadBudget {
  constructor(private readonly limits: BudgetLimits = DEFAULT_LIMITS) {}

  check(input: BudgetInput): BudgetResult {
    const failures: string[] = [];
    const report: string[] = [];
    this.#checkOps(input, failures);
    this.#checkThroughput(input, failures, report);
    if (input.metrics !== undefined) {
      this.#checkLatency(input.metrics, failures, report);
      LoadBudget.#describeStatuses(input.metrics, report);
    }
    return { failures, report };
  }

  #checkOps(input: BudgetInput, failures: string[]): void {
    for (const op of OPS) {
      const s = input.stats.get(op.name);
      if (s === undefined || s.calls === 0) continue;
      if (s.errors > 0) {
        failures.push(
          `${op.name}: ${s.errors}/${s.calls} calls failed at the transport, last: ${s.lastDetail}`,
        );
      }
      if (s.unexpected.size > 0) {
        const seen = [...s.unexpected]
          .map(([status, n]) => `${status} x${n}`)
          .join(', ');
        failures.push(
          `${op.name}: answered ${seen}, which it names neither work nor a refusal`,
        );
      }
      // An op whose service is absent is refused by design, so flooring it would
      // fail every run on a laptop with nothing up.
      if (op.requires === 'redis' && !input.redisUp) continue;
      const answered = s.worked + s.refused;
      if (answered === 0) continue;
      const share = s.worked / answered;
      if (share < this.limits.minWorkShare) {
        failures.push(
          `${op.name}: only ${(share * 100).toFixed(1)}% of ${answered} answered calls did work ` +
            `(${s.refused} refused), under the ${(this.limits.minWorkShare * 100).toFixed(0)}% floor`,
        );
      }
    }
  }

  #checkThroughput(
    input: BudgetInput,
    failures: string[],
    report: string[],
  ): void {
    let worked = 0;
    let refused = 0;
    for (const s of input.stats.values()) {
      worked += s.worked;
      refused += s.refused;
    }
    const rate = worked / input.elapsedSeconds;
    report.push(
      `${worked} calls did work, ${refused} were refused, ${rate.toFixed(0)} working calls/s`,
    );
    if (rate < this.limits.minCallsPerSecond) {
      failures.push(
        `${rate.toFixed(0)} working calls/s is under the ${this.limits.minCallsPerSecond}/s floor`,
      );
    }
  }

  #checkLatency(
    metrics: HttpStatsReport,
    failures: string[],
    report: string[],
  ): void {
    const slowest = [...metrics.routes]
      .filter((r) => r.count > 0)
      .sort((a, b) => (b.duration.p99 ?? 0) - (a.duration.p99 ?? 0));
    report.push('slowest routes by p99 (server side):');
    for (const route of slowest.slice(0, 5)) {
      report.push(
        `  ${`${route.method} ${route.route}`.padEnd(30)} ` +
          `n=${String(route.count).padStart(6)} ` +
          `p50 ${LoadBudget.#ms(route.duration.p50)} ` +
          `p99 ${LoadBudget.#ms(route.duration.p99)} ` +
          `max ${LoadBudget.#ms(route.duration.max)}`,
      );
    }
    for (const route of slowest) {
      const p99 = (route.duration.p99 ?? 0) / NS_PER_MS;
      const max = (route.duration.max ?? 0) / NS_PER_MS;
      const where = `${route.method} ${route.route}`;
      if (p99 > this.limits.maxP99Ms) {
        failures.push(
          `${where}: p99 ${p99.toFixed(0)}ms over the ${this.limits.maxP99Ms}ms budget ` +
            `(slowest trace ${route.slowestTraceId ?? 'unrecorded'})`,
        );
      }
      if (max > this.limits.maxSingleRequestMs) {
        failures.push(
          `${where}: one request took ${max.toFixed(0)}ms, over the ` +
            `${this.limits.maxSingleRequestMs}ms ceiling ` +
            `(trace ${route.slowestTraceId ?? 'unrecorded'})`,
        );
      }
    }
  }

  /** The server's own count per status, which is what proved the 429 problem. */
  static #describeStatuses(metrics: HttpStatsReport, report: string[]): void {
    const totals = new Map<string, number>();
    let all = 0;
    for (const route of metrics.routes) {
      for (const [status, n] of Object.entries(route.byStatus)) {
        totals.set(status, (totals.get(status) ?? 0) + n);
        all += n;
      }
    }
    if (all === 0) return;
    const shares = [...totals]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, n]) => `${status}: ${((n / all) * 100).toFixed(1)}%`)
      .join('  ');
    report.push(`server saw ${all} requests - ${shares}`);
  }

  static #ms(ns: number | undefined): string {
    return ns === undefined
      ? '-'
      : `${(ns / NS_PER_MS).toFixed(2)}ms`.padStart(9);
  }
}
