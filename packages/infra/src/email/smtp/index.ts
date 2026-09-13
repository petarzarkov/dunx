import { createTransport } from 'nodemailer';
import { EmailSendError } from '../errors.js';
import {
  formatAddress,
  type EmailResult,
  type OutboundEmail,
} from '../message.js';
import { EmailTransport } from '../transport.js';

/**
 * The part of a nodemailer transporter this uses, declared rather than imported
 * so a test can hand over a stub without a server listening.
 */
export interface SmtpMailer {
  sendMail(payload: Record<string, unknown>): Promise<{
    messageId?: string;
    accepted?: readonly (string | { address: string })[];
    rejected?: readonly unknown[];
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
    const config = init.transport ?? init.url;
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

  async send(message: OutboundEmail): Promise<EmailResult> {
    const info = await this.#mailer.sendMail(payload(message));
    if (info.rejected !== undefined && info.rejected.length > 0) {
      throw new EmailSendError(
        'smtp',
        `${String(info.rejected.length)} recipient(s) rejected`,
      );
    }
    return {
      id: info.messageId,
      // nodemailer reports what the server accepted, which is the honest answer
      // and can be shorter than what was asked for.
      accepted: (info.accepted ?? []).map((a) =>
        typeof a === 'string' ? a : a.address,
      ),
      transport: this.name,
    };
  }
}

const payload = (message: OutboundEmail): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    from: formatAddress(message.from),
    to: message.to.map(formatAddress).join(', '),
    subject: message.subject,
  };
  if (message.cc.length > 0)
    body['cc'] = message.cc.map(formatAddress).join(', ');
  if (message.bcc.length > 0) {
    body['bcc'] = message.bcc.map(formatAddress).join(', ');
  }
  if (message.replyTo !== undefined) {
    body['replyTo'] = formatAddress(message.replyTo);
  }
  if (message.html !== undefined) body['html'] = message.html;
  if (message.text !== undefined) body['text'] = message.text;
  if (Object.keys(message.headers).length > 0) {
    body['headers'] = message.headers;
  }
  if (message.attachments.length > 0) {
    body['attachments'] = message.attachments.map((a) => ({
      filename: a.filename,
      content: a.content,
      ...(a.contentType === undefined ? {} : { contentType: a.contentType }),
    }));
  }
  return body;
};
