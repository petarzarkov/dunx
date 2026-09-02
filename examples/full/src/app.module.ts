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
import { StatsModule } from './stats/stats.module.js';
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

/** `transports` replaces the console sink, so keeping stdout means naming it. */
const fileAndConsole = (path: string): Transport[] => [
  new ConsoleTransport(),
  new FileTransport({
    path,
    interval: 'daily',
    maxFiles: 7,
    bufferBytes: 16 * 1024,
  }),
];

/** Import order is construction order and shutdown runs in reverse, so config
 * and the logger are built first and torn down last. */
@Module({
  imports: [
    ConfigModule.forRoot({ validate, as: AppConfigService }),
    // `captureGlobalErrors` turns an uncaught exception into a fatal entry
    // flushed before exit.
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
    // After CacheModule, which binds the connection its counter writes to.
    LimitsModule,
    MaintenanceModule,
    AssetsModule,
    UpstreamModule,
    GuardsModule,
    // After DatabaseModule, so better-auth reuses the connection it opened.
    AccountsModule,
    ProbesModule,
    WiringModule,
    DocsModule,
    // After JobsModule and CacheModule, which bind what it reads and probes.
    OpsModule,
    StatsModule,
  ],
  providers: [Tour],
  // `OpenApiModule` wraps this module, so its factory resolves from here.
  exports: [Auth],
})
export class AppModule {}
