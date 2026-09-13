import { Logger, Module } from '@dunx/core';
import {
  EmailModule,
  EmailService,
  LogTransport,
  type EmailTransport,
} from '@dunx/infra/email';
import { ResendTransport } from '@dunx/infra/email/resend';
import { SmtpTransport } from '@dunx/infra/email/smtp';
import { AppConfigService, type AppConfig } from '../config.js';
import { MailDemo } from './email.demo.js';
import { MailController } from './mail.controller.js';
import { Notices } from './notices.service.js';
import renderer from './render.js';

/** `EMAIL_RESEND_KEY=` parses as `''`, which is set and useless. */
const set = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== '';

/**
 * One `EmailTransport` per configured provider, chosen once at boot. Each vendor
 * sits on its own subpath; this app imports all three because it demonstrates
 * all three, and a real app imports the one it sends with.
 *
 * A provider named without its credential degrades to the log transport rather
 * than failing boot, which `dryRun` would otherwise promise and not deliver.
 */
const transportFor = (
  email: AppConfig['email'],
  logger: Logger,
): EmailTransport => {
  if (email.transport === 'resend' && set(email.resendKey)) {
    return new ResendTransport({ apiKey: email.resendKey });
  }
  if (email.transport === 'smtp' && set(email.smtpUrl)) {
    return new SmtpTransport({ url: email.smtpUrl });
  }
  if (email.transport !== 'log') {
    logger.warn(
      `EMAIL_TRANSPORT=${email.transport} needs its credential, and none is ` +
        `set. Sending through the log transport instead.`,
    );
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
          // The same instance `dunx-email --renderer ./src/email/render.ts`
          // loads, so the preview cannot drift from what a send produces.
          renderer,
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
