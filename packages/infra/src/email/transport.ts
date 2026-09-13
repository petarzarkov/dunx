import type { EmailResult, OutboundEmail } from './message.js';

/**
 * The one contract every backend satisfies. Inject this, never `ResendTransport`
 * or `SmtpTransport`, and swapping the provider is a change to one `forRoot`
 * call.
 *
 * An abstract class, not an interface, because a dunx constructor parameter has
 * to name something that exists at runtime for `@dunx/transform` to record it.
 */
export abstract class EmailTransport {
  /** Reported in {@link EmailResult.transport} and in the dry-run log line. */
  abstract readonly name: string;

  /**
   * Delivers the message, or throws {@link EmailSendError}.
   *
   * The message arrives resolved: `from` is filled in, every recipient is an
   * object, and `to`, `cc`, `bcc`, `attachments` and `headers` are always
   * present. A transport maps that onto its provider and nothing else.
   */
  abstract send(message: OutboundEmail): Promise<EmailResult>;
}
