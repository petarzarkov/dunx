import { Logger, Module } from '@dunx/core';
import {
  EmailModule,
  EmailService,
  LogTransport,
  type EmailTransport,
} from '@dunx/infra/email';
import { ReactEmailRenderer } from '@dunx/infra/email/react';
import { ResendTransport } from '@dunx/infra/email/resend';
import { SmtpTransport } from '@dunx/infra/email/smtp';
import { AppConfigService, type AppConfig } from '../config.js';
import { MailDemo } from './email.demo.js';
import { MailController } from './mail.controller.js';
import { Notices } from './notices.service.js';

/**
 * One `EmailTransport` per configured provider, chosen once at boot.
 *
 * Each vendor sits on its own subpath, so importing `@dunx/infra/email` alone
 * needs neither `resend` nor `nodemailer`. This app imports all three because it
 * demonstrates all three; a real app imports the one it sends with.
 */
const transportFor = (
  email: AppConfig['email'],
  logger: Logger,
): EmailTransport => {
  if (email.transport === 'resend') {
    return new ResendTransport({ apiKey: email.resendKey ?? '' });
  }
  if (email.transport === 'smtp') {
    return new SmtpTransport({ url: email.smtpUrl ?? '' });
  }
  return new LogTransport(logger);
};

@Module({
  imports: [
    /**
     * `dryRun` is on by default here, so the configured transport is built and
     * bound and nothing reaches an inbox. Flipping one variable is the whole
     * difference between this and production.
     */
    EmailModule.forRootAsync({
      useFactory: (config: AppConfigService, logger: Logger) => {
        const email = config.get('email');
        return {
          transport: transportFor(email, logger),
          from: email.from,
          maxPerSecond: email.maxPerSecond,
          dryRun: email.dryRun,
          renderer: new ReactEmailRenderer(),
        };
      },
      inject: [AppConfigService, Logger] as const,
    }),
  ],
  controllers: [MailController],
  providers: [Notices, MailDemo],
  exports: [EmailService, Notices, MailDemo],
})
export class MailModule {}
