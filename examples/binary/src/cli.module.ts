import { ConfigModule, Module } from '@dunx/core';
import { LoggerModule, StreamTransport } from '@dunx/infra/logger';
import { CliConfigService, validate } from './config/settings.js';
import { GreeterService } from './greeter/greeter.service.js';
import { ReportService } from './report/report.service.js';

/**
 * The CLI is a dunx app, not a script: the same container, lifecycle and config
 * contract a server uses. Everything logs to stderr through one `StreamTransport`
 * so stdout carries a command's JSON alone - the default console logger would
 * split info to stdout and corrupt it. See README.md.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ validate, as: CliConfigService }),
    LoggerModule.forRootAsync({
      useFactory: (config: CliConfigService) => ({
        name: config.get('name'),
        level: config.get('logLevel'),
        transports: [
          new StreamTransport(process.stderr, {
            level: config.get('logLevel'),
          }),
        ],
      }),
      inject: [CliConfigService] as const,
    }),
  ],
  providers: [GreeterService, ReportService],
})
export class CliModule {}
