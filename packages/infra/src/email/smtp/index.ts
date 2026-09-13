import { createTransport } from 'nodemailer';
import { EmailSendError } from '../errors.js';
import {
  formatAddress,
  type EmailResult,
  type OutboundEmail,
} from '../message.js';
import { toPayload, withContentType } from '../payload.js';
import { EmailTransport } from '../transport.js';

/**
 * The part of a nodemailer transporter this uses, declared rather than imported
 * so a test can hand over a stub without a server listening.
 */
export interface SmtpMailer {
  /** nodemailer's own: opens the connection and runs the greeting and AUTH. */
  verify?(): Promise<unknown>;
  sendMail(payload: Record<string, unknown>): Promise<{
    messageId?: string;
    accepted?: readonly (string | { address: string })[];
    rejected?: readonly (string | { address: string })[];
  }>;
}

export interface SmtpTransportInit {
  /** `smtp://user:pass@host:587` or `smtps://...`. */
  readonly url?: string;
  /** Anything `nodemailer.createTransport` accepts, when a URL is too little. */
  readonly transport?: Record<string, unknown>;
  /** An already-built transporter, which is what a test passes. */
  readonly mailer?: SmtpMailer;
}

/**
 * SMTP, through nodemailer.
 *
 * There is no Bun SMTP client and SMTP is not a `fetch`: it is a stateful
 * dialogue over TCP with STARTTLS, AUTH and dot-stuffing. `Bun.connect` gives
 * the socket and nothing above it, so writing the client here would be inventing
 * what a mature library already solves. nodemailer stays an optional peer.
 */
export class SmtpTransport extends EmailTransport {
  readonly name = 'smtp';
  readonly #mailer: SmtpMailer;

  constructor(init: SmtpTransportInit) {
    super();
    if (init.mailer !== undefined) {
      this.#mailer = init.mailer;
      return;
    }
    // `''` counts as missing, not as a url. A caller reading the url off
    // configuration writes `url: config.smtpUrl ?? ''`, and nodemailer answers
    // an empty one with an error of its own rather than this one.
    const config =
      init.transport ??
      (init.url === undefined || init.url === '' ? undefined : init.url);
    if (config === undefined) {
      throw new EmailSendError(
        'smtp',
        'SmtpTransport needs a url, a transport config or a mailer.',
      );
    }
    this.#mailer = createTransport(
      config as Parameters<typeof createTransport>[0],
    ) as unknown as SmtpMailer;
  }

  /** nodemailer's `verify`, with its failure named like every other one here. */
  override async verify(): Promise<void> {
    if (this.#mailer.verify === undefined) return;
    try {
      await this.#mailer.verify();
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new EmailSendError('smtp', detail, { cause });
    }
  }

  async send(message: OutboundEmail): Promise<EmailResult> {
    let info;
    try {
      info = await this.#mailer.sendMail(payload(message));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new EmailSendError('smtp', detail, { cause });
    }
    // nodemailer reports what the server accepted, which is the honest answer
    // and can be shorter than what was asked for.
    const accepted = (info.accepted ?? []).map(address);
    const rejected = (info.rejected ?? []).map(address);
    // **Only a total failure throws.** An SMTP server may take some recipients
    // and refuse others, and the message is then already in the accepted
    // inboxes: throwing there invites a retry that delivers a second copy.
    if (accepted.length === 0) {
      throw new EmailSendError(
        'smtp',
        `every recipient was rejected (${rejected.length || 'none accepted'})`,
      );
    }
    return { id: info.messageId, accepted, rejected, transport: this.name };
  }
}

/** nodemailer reports a recipient either as a string or as an object. */
const address = (a: string | { address: string }): string =>
  typeof a === 'string' ? a : a.address;

/** nodemailer takes one comma-separated header line per recipient field. */
const payload = (message: OutboundEmail): Record<string, unknown> =>
  toPayload(message, {
    recipients: (list) => list.map(formatAddress).join(', '),
    attachment: (file) => withContentType(file, file.content),
  });
