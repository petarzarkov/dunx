import { Auth } from '@dunx/auth';
import { ConfigModule, Module } from '@dunx/core';
import {
  ConsoleTransport,
  FileTransport,
  LoggerModule,
  type Transport,
} from '@dunx/infra/logger';
import { AccountsModule } from './auth/auth.module.js';
import { CacheModule } from './cache/cache.module.js';
import { ChatModule } from './chat/chat.module.js';
import { AppConfigService, validate } from './config.js';
import { OpsModule } from './dashboard/dashboard.module.js';
import { DatabaseModule } from './database/database.module.js';
import { DocsModule } from './docs/docs.module.js';
import { GuardsModule } from './guards/guards.module.js';
import { AssetsModule } from './assets/assets.module.js';
import { ProbesModule } from './health/health.module.js';
import { HttpModule } from './http/http.module.js';
import { JobsModule } from './jobs/jobs.module.js';
import { NotesModule } from './notes/notes.module.js';
import { MaintenanceModule } from './schedule/schedule.module.js';
import { LimitsModule } from './throttle/throttle.module.js';
import { UpstreamModule } from './upstream/upstream.module.js';
import { PicturesModule } from './pictures/pictures.module.js';
import { StorageModule } from './storage/storage.module.js';
import { Tour } from './tour/tour.service.js';
import { UsersModule } from './users/users.module.js';
import { WiringModule } from './wiring/wiring.module.js';

/**
 * Supplying `transports` *replaces* the console sink, so keeping stdout means
 * naming it. The file transport buffers, which is safe because `LoggerModule`
 * flushes and closes it from `onShutdown`.
 */
const fileAndConsole = (path: string): Transport[] => [
  new ConsoleTransport(),
  new FileTransport({
    path,
    interval: 'daily',
    maxFiles: 7,
    bufferBytes: 16 * 1024,
  }),
];

/**
 * Import order is construction order, and shutdown runs in reverse - so config
 * and the logger are built first and torn down last, and the database and the
 * workspace outlive every feature that uses them.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ validate, as: AppConfigService }),
    // The level comes from the validated config, which is the one thing a
    // zero-argument `forRoot` function cannot reach. `captureGlobalErrors` turns
    // an uncaught exception into a fatal entry that is flushed before exit -
    // worth having in a service that is meant to stay up.
    LoggerModule.forRootAsync(
      {
        useFactory: (config: AppConfigService) => {
          const log = config.get('log');
          return {
            name: config.get('appName'),
            level: log.level,
            ...(log.file === undefined
              ? {}
              : { transports: fileAndConsole(log.file) }),
          };
        },
        inject: [AppConfigService] as const,
      },
      { captureGlobalErrors: true },
    ),
    DatabaseModule,
    StorageModule,
    PicturesModule,
    CacheModule,
    HttpModule,
    UsersModule,
    NotesModule,
    ChatModule,
    JobsModule,
    // After CacheModule, whose RedisModule binds the connection the shared
    // throttle counter writes to.
    LimitsModule,
    MaintenanceModule,
    AssetsModule,
    UpstreamModule,
    GuardsModule,
    // After DatabaseModule, so better-auth reuses the connection it opened - and so
    // the auth tables are created after the ledger's, both at onInit.
    AccountsModule,
    ProbesModule,
    WiringModule,
    DocsModule,
    // After JobsModule, whose QueueModule.forRoot binds the publisher it reads,
    // and after CacheModule, whose RedisModule binds the connection it probes.
    OpsModule,
  ],
  providers: [Tour],
  // `OpenApiModule` wraps this module rather than being imported by it, so its
  // factory resolves from here: `Auth` is exported for `betterAuthDocument`.
  exports: [Auth],
})
export class AppModule {}
