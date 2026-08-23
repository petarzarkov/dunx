import { Module } from '@dunx/core';
import { ScheduleModule } from '@dunx/infra/schedule';
import { AppConfigService } from '../config.js';
import { Maintenance } from './maintenance.service.js';
import { ScheduleDemo } from './schedule.demo.js';

/**
 * `Bun.cron` behind `@Cron`, `@Interval` and `@OnceOnBoot`, armed at boot.
 *
 * `keepAlive: false`: `Bun.cron` would hold the event loop open, and this app has
 * a server doing that already while `bun run tour` has to exit. `tz` comes from
 * the config, and a named zone is refused at boot on a Bun that ignores it.
 */
@Module({
  imports: [
    ScheduleModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        tz: config.get('schedule').tz,
        keepAlive: false,
      }),
      inject: [AppConfigService] as const,
    }),
  ],
  providers: [Maintenance, ScheduleDemo],
  exports: [Maintenance, ScheduleDemo],
})
export class MaintenanceModule {}
