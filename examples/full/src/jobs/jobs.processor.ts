import { JobProcessor } from '@dunx/infra/queue';
import { ConfigModule, Module } from '@dunx/core';
import { LoggerModule } from '@dunx/infra/logger';
import { AppConfigService, validate } from '../config.js';
import { JobsModule } from './jobs.module.js';

/**
 * **The file bullmq forks into.** Its default export is the processor, and nothing
 * else here runs in the parent.
 *
 * The child builds its own container, which is the whole point: a handler gets the
 * database, the image pipeline and the logger it declares, without sharing an event
 * loop with the process serving HTTP. `JobProcessor` builds it once per child and
 * reuses it for every job on that child.
 *
 * Its own module rather than reusing `WorkerModule` from `worker.ts`: that file is
 * an entrypoint with a `run()` at the bottom, and importing it here would boot a
 * second worker inside every child.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ validate, as: AppConfigService }),
    LoggerModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        // Named so a line from a child is attributable to one on sight - which is
        // the traceability a sandbox is for.
        name: `${config.get('appName')}-job`,
        level: config.get('log').level,
      }),
      inject: [AppConfigService] as const,
    }),
    JobsModule,
  ],
})
class JobProcessorModule {}

export default new JobProcessor(JobProcessorModule).handle;
