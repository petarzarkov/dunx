import { Module } from '@dunx/core';
import { ScheduleModule } from '@dunx/infra/schedule';
import { AppConfigService } from '../config.js';
import { Maintenance } from './maintenance.service.js';
import { ScheduleDemo } from './schedule.demo.js';

/**
 * `Bun.cron` behind `@Cron`, `@Interval` and `@OnceOnBoot`, armed at boot.
 *
 * `keepAlive: false`, unlike the default. `Bun.cron` holds the event loop open so a
 * process with an armed schedule and nothing else to do waits for the next fire;
 * this app has a server holding it open already, and `bun run tour` has to exit.
 *
 * `tz` comes from the config because that is the one thing a zero-argument
 * `forRoot` cannot reach. A named zone is refused at boot on a Bun that ignores
 * `Bun.cron`'s `tz` option, rather than running at the UTC hour and saying nothing.
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
