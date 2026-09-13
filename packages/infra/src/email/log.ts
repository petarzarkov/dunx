import type { Logger } from '@dunx/core';
import {
  everyRecipient,
  formatAddress,
  type EmailResult,
  type OutboundEmail,
} from './message.js';
import { EmailTransport } from './transport.js';

/**
 * Writes the message it would have sent and returns.
 *
 * The default when nothing is configured, and what `dryRun` routes to, so an app
 * boots and a queue demonstrably delivers a job to a worker on a machine with no
 * provider credentials. Both reach the same class, so there is one definition of
 * "sent nowhere" rather than two that drift.
 *
 * The bodies are logged at `debug` and everything else at `info`: an email body
 * is the field most likely to carry something personal, and a dry run is exactly
 * when someone wants to read it.
 */
export class LogTransport extends EmailTransport {
  readonly name = 'log';

  constructor(private readonly logger: Logger) {
    super();
  }

  /** Nothing to reach, so nothing can be unreachable. */
  override verify(): Promise<void> {
    return Promise.resolve();
  }

  send(message: OutboundEmail): Promise<EmailResult> {
    const accepted = everyRecipient(message);
    this.logger.info('email not sent, the log transport is in use', {
      from: formatAddress(message.from),
      to: accepted,
      subject: message.subject,
    });
    this.logger.debug('email body', {
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
    return Promise.resolve({
      id: undefined,
      accepted,
      rejected: [],
      transport: this.name,
    });
  }
}
