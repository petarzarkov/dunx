import { Logger } from '@dunx/core';
import { Readiness, type HealthReport } from '@dunx/http';

/**
 * The two probes an orchestrator reads, and the one thing about them that is worth
 * demonstrating rather than describing: `Readiness.hold()` takes the pod out of
 * rotation while liveness keeps passing, so a migration sheds traffic without
 * inviting a restart.
 */
export class HealthDemo {
  constructor(
    private readonly logger: Logger,
    private readonly readiness: Readiness,
  ) {}

  async demonstrate(url: string): Promise<void> {
    const get = async (
      path: string,
    ): Promise<{ status: number; body: HealthReport }> => {
      const response = await fetch(new URL(`api/health/${path}`, url));
      return {
        status: response.status,
        body: (await response.json()) as HealthReport,
      };
    };

    const live = await get('live');
    this.logger.info(
      `GET /api/health/live -> ${live.status} ${live.body.status}, ` +
        `${this.describe(live.body)}`,
    );

    const ready = await get('ready');
    this.logger.info(
      `GET /api/health/ready -> ${ready.status} ${ready.body.status}, ` +
        `${this.describe(ready.body)}`,
    );

    // A non-critical check that is down does not shed traffic, which is the whole
    // reason `critical` exists. With no Redis running, this is that case observed.
    const soft = ready.body.checks.filter(
      (check) => !check.critical && check.state !== 'up',
    );
    this.logger.info(
      soft.length === 0
        ? 'every check up, so critical and non-critical read the same today'
        : `non-critical and down: ${soft.map((c) => c.name).join(', ')} - ` +
            `readiness is still ${ready.body.status}`,
    );

    // Taking the pod out by hand, the way a migration would.
    this.readiness.hold('migrating');
    const held = await get('ready');
    const heldLive = await get('live');
    this.logger.info(
      `readiness.hold("migrating") -> ready ${held.status} ` +
        `${held.body.checks[0]?.detail ?? ''}, live still ${heldLive.status}`,
    );

    this.readiness.release();
    this.logger.info(
      `readiness.release() -> ready ${(await get('ready')).status}`,
    );
  }

  private describe(report: HealthReport): string {
    const checks = report.checks
      .map((check) => `${check.name}=${check.state}`)
      .join(' ');
    return `${report.uptimeMs} ms up, ${checks || 'no checks'}`;
  }
}
