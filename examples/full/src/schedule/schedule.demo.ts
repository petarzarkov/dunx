import { Logger } from '@dunx/core';
import { ScheduleRegistry } from '@dunx/infra/schedule';
import { Maintenance } from './maintenance.service.js';

/**
 * What is armed, and what a schedule does when it is not waiting for a clock.
 *
 * `trigger` is the reason `ScheduleRegistry` is injectable: a cron at 03:00 is
 * otherwise untestable without waiting, and an operator forcing a nightly job has
 * nowhere else to go.
 */
export class ScheduleDemo {
  constructor(
    private readonly logger: Logger,
    private readonly registry: ScheduleRegistry,
    private readonly maintenance: Maintenance,
  ) {}

  async demonstrate(): Promise<void> {
    for (const entry of this.registry.list()) {
      const next =
        entry.nextRunAt === undefined
          ? 'a timer, so no next fire to compute'
          : `next ${entry.nextRunAt.toISOString()}`;
      this.logger.info(
        `${entry.kind.padEnd(8)} ${entry.name} at ${String(entry.at)} - ${next}`,
      );
    }

    // The @OnceOnBoot already ran, before listen() bound the port.
    this.logger.info(
      `@OnceOnBoot fired at boot -> warmed=${this.maintenance.counts.warmed}`,
    );

    // Off its own cadence, honouring overlap. The cron is a 03:00 daily.
    await this.registry.trigger('maintenance.compact');
    await this.registry.trigger('maintenance.sweep');
    const counts = this.maintenance.counts;
    this.logger.info(
      `trigger() x2 -> ${counts.compactions} compaction, ${counts.sweeps} sweep, ` +
        'neither waited for a clock',
    );

    const entry = this.registry.get('maintenance.compact');
    this.logger.info(
      `runs recorded on the entry -> ${entry?.runs ?? 0}, lastError ` +
        `${entry?.lastError?.message ?? 'none'}`,
    );

    // Removing one disarms it. A feature flag has nowhere else to live.
    this.logger.info(
      `remove("maintenance.sweep") -> ${this.registry.remove('maintenance.sweep')}, ` +
        `${this.registry.list().length} left armed`,
    );
  }
}
