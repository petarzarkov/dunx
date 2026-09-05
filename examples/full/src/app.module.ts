import { Auth } from '@dunx/auth';
import { ConfigModule, Module } from '@dunx/core';
import {
  ConsoleTransport,
  FileTransport,
  jsonFormat,
  logfmtFormat,
  type LogFormatter,
  LoggerModule,
  textFormat,
  type Transport,
} from '@dunx/infra/logger';
import { AccountsModule } from './auth/auth.module.js';
import { CacheModule } from './cache/cache.module.js';
import { ChatModule } from './chat/chat.module.js';
import { ProtocolsModule } from './protocols/protocols.module.js';
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

/**
 * JSON is what a log shipper reads; the other two are for a person and for a
 * `key=value` reader. `undefined` leaves `ConsoleTransport` on its own default,
 * which is coloured JSON at a terminal and plain JSON anywhere else.
 */
const formatters: Record<string, LogFormatter | undefined> = {
  json: undefined,
  text: textFormat,
  logfmt: logfmtFormat,
};

/** `transports` replaces the console sink, so keeping stdout means naming it. */
const fileAndConsole = (
  path: string,
  format: LogFormatter | undefined,
): Transport[] => [
  new ConsoleTransport(format === undefined ? {} : { format }),
  new FileTransport({
    path,
    interval: 'daily',
    maxFiles: 7,
    bufferBytes: 16 * 1024,
    // A file is read by a machine even when the console is not, so it never
    // takes the terminal formatter.
    format: format === logfmtFormat ? logfmtFormat : jsonFormat,
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
          const format = formatters[log.format];
          return {
            name: config.get('appName'),
            level: log.level,
            ...(log.file === undefined
              ? format === undefined
                ? {}
                : { transports: [new ConsoleTransport({ format })] }
              : { transports: fileAndConsole(log.file, format) }),
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
    ProtocolsModule,
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
