import { Module } from '@dunx/core';
import { FilesModule, LocalStorageOptions } from '@dunx/files';
import { join } from 'node:path';
import { ReportsService } from './reports.service.js';

/**
 * Outside the repo tree and unique per run, so concurrent runs never collide.
 * main.ts removes it on the way out.
 */
export const DATA_ROOT = join(
  Bun.env['TMPDIR'] ?? '/tmp',
  `dunx-files-example-${crypto.randomUUID()}`,
);

/**
 * `forRootAsync` rather than `forRoot`, to show the configuration being awaited:
 * dunx settles async factories before any constructor runs, so ReportsService
 * still receives a fully built Storage.
 */
@Module({
  imports: [
    FilesModule.forRootAsync({
      useFactory: async () => {
        await Bun.sleep(1);
        return new LocalStorageOptions(DATA_ROOT);
      },
    }),
  ],
  providers: [ReportsService],
})
export class AppModule {}
