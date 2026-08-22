import type { HealthIndicator, ProbeResult, ProbeState } from './contracts.js';
import type { Readiness } from './readiness.js';

export interface HealthCheckReport {
  readonly name: string;
  readonly state: ProbeState;
  readonly critical: boolean;
  /** How long the check took, rounded to a millisecond. */
  readonly ms: number;
  readonly detail?: string;
}

/**
 * The wire format, declared here and imported by anything that renders it.
 *
 * One list rather than terminus' four fields holding the same data partitioned
 * three ways: a reader wants to know which check is unhappy, and partitioning by
 * outcome means looking in three places to find out.
 */
export interface HealthReport {
  readonly status: ProbeState;
  readonly draining: boolean;
  /** Measured on a monotonic clock, so it never goes backwards. */
  readonly uptimeMs: number;
  readonly checks: readonly HealthCheckReport[];
}

/**
 * A probe that does not answer inside its budget is `unknown`, not `down`.
 *
 * The timer is unref'd: a health check must never be the reason a process stays
 * alive, which matters because `liveness()` is also reachable from a test.
 */
const bounded = async (
  indicator: HealthIndicator,
  timeoutMs: number,
): Promise<ProbeResult> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ProbeResult>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({ state: 'unknown', detail: `no answer in ${timeoutMs} ms` }),
      timeoutMs,
    );
    (timer as unknown as { unref?: () => void }).unref?.();
  });

  try {
    return await Promise.race([
      // A throwing check is `down` with its message: it answered, badly.
      Promise.resolve()
        .then(() => indicator.check())
        .catch((error: unknown) => ({
          state: 'down' as const,
          detail: error instanceof Error ? error.message : String(error),
        })),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const worst = (checks: readonly HealthCheckReport[]): ProbeState => {
  const critical = checks.filter((check) => check.critical);
  if (critical.some((check) => check.state === 'down')) return 'down';
  if (critical.some((check) => check.state === 'unknown')) return 'unknown';
  return 'up';
};

export class HealthOptions {
  readonly liveness: readonly HealthIndicator[];
  readonly readiness: readonly HealthIndicator[];
  readonly timeoutMs: number;
  /** Mount `/health/live` and `/health/ready`. Default `true`. */
  readonly routes: boolean;
  /** Include the two routes in the OpenAPI document. Default `true`. */
  readonly documented: boolean;
  /** How long to fail readiness before the server stops accepting. Default `0`. */
  readonly drainDelayMs: number;

  constructor(init: HealthOptionsInit = {}) {
    this.liveness = init.liveness ?? [];
    this.readiness = init.readiness ?? [];
    this.timeoutMs = init.timeoutMs ?? 2000;
    this.routes = init.routes ?? true;
    this.documented = init.documented ?? true;
    this.drainDelayMs = Math.max(0, init.drainDelayMs ?? 0);
  }
}

export interface HealthOptionsInit {
  /** Checked by `/health/live`: is this process still working. */
  readonly liveness?: readonly HealthIndicator[];
  /** Checked by `/health/ready`: should it receive traffic. */
  readonly readiness?: readonly HealthIndicator[];
  /** Per-indicator budget. Default `2000`. */
  readonly timeoutMs?: number;
  readonly routes?: boolean;
  /**
   * `false` mounts `HiddenHealthController`, so the probes are served and left out
   * of the document. They are documented by default: the paths and the report are
   * worth finding in the reference, and an orchestrator reads neither.
   */
  readonly documented?: boolean;
  /** Passed through to {@link ReadinessOptions}. */
  readonly drainDelayMs?: number;
}

/** Runs the indicators and shapes the report. Never throws. */
export class HealthRegistry {
  /**
   * `performance.now()`, not `Date.now()`. A duration taken from the wall clock is
   * wrong whenever the wall clock is adjusted: an NTP correction, a suspend and
   * resume, or a VM resyncing with its host all step it, and a backwards step made
   * this report a *negative* uptime. That is not hypothetical - it was caught by a
   * probe answering `uptimeMs: -242` under WSL2, where the guest clock is resynced
   * routinely, which also made `uptimeMs >= 0` a flaky assertion.
   */
  readonly #startedAt = performance.now();

  constructor(
    private readonly options: HealthOptions,
    private readonly readiness_: Readiness,
  ) {}

  /**
   * Concurrently, each bounded by `timeoutMs`, so the report costs the slowest
   * check rather than their sum.
   */
  async report(indicators: readonly HealthIndicator[]): Promise<HealthReport> {
    const checks = await Promise.all(
      indicators.map(async (indicator): Promise<HealthCheckReport> => {
        const started = performance.now();
        const result = await bounded(indicator, this.options.timeoutMs);
        return {
          name: indicator.name,
          state: result.state,
          critical: indicator.critical,
          ms: Math.round(performance.now() - started),
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        };
      }),
    );

    return {
      status: worst(checks),
      draining: this.readiness_.draining,
      // Rounded, because a monotonic clock is fractional and a millisecond count
      // with seventeen decimal places reads like a bug in the probe.
      uptimeMs: Math.round(performance.now() - this.#startedAt),
      checks,
    };
  }

  /**
   * Is the process working. **Draining does not fail liveness**: a pod that is
   * shutting down is not a pod that needs killing, and reporting `down` here invites
   * the orchestrator to SIGKILL it mid-drain.
   */
  liveness(): Promise<HealthReport> {
    return this.report(this.options.liveness);
  }

  /** Should the process receive traffic. Draining fails it, before anything runs. */
  async readiness(): Promise<HealthReport> {
    const report = await this.report(this.options.readiness);
    if (!this.readiness_.draining) return report;

    return {
      ...report,
      status: 'down',
      checks: [
        {
          name: 'readiness',
          state: 'down',
          critical: true,
          ms: 0,
          detail: this.readiness_.reason ?? 'not accepting traffic',
        },
        ...report.checks,
      ],
    };
  }
}
