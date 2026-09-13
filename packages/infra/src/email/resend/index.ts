import { Resend } from 'resend';
import { EmailSendError } from '../errors.js';
import {
  everyRecipient,
  formatAddress,
  type EmailResult,
  type OutboundEmail,
} from '../message.js';
import { EmailTransport } from '../transport.js';

/**
 * The part of the `resend` client this uses. Declared rather than imported so a
 * test can hand over a stub without a network, and so the transport names what
 * it actually depends on.
 */
export interface ResendClient {
  readonly emails: {
    send(payload: Record<string, unknown>): Promise<{
      data: { id: string } | null;
      error: { name: string; message: string } | null;
    }>;
  };
}

export interface ResendTransportInit {
  readonly apiKey?: string;
  /** An already-built client, which is what a test passes. */
  readonly client?: ResendClient;
}

/**
 * Resend, through its own SDK.
 *
 * Resend enforces a per-second cap and answers a breach with a 429 inside a job
 * handler, which is what `maxPerSecond` on `EmailModule` exists for. This
 * transport does no pacing of its own: one rate limiter, owned by the service
 * that knows about every send.
 */
export class ResendTransport extends EmailTransport {
  readonly name = 'resend';
  readonly #client: ResendClient;

  constructor(init: ResendTransportInit) {
    super();
    if (init.client !== undefined) {
      this.#client = init.client;
    } else if (init.apiKey !== undefined && init.apiKey !== '') {
      this.#client = new Resend(init.apiKey) as unknown as ResendClient;
    } else {
      throw new EmailSendError(
        'resend',
        'ResendTransport needs an apiKey or a client.',
      );
    }
  }

  async send(message: OutboundEmail): Promise<EmailResult> {
    const { data, error } = await this.#client.emails.send(payload(message));
    if (error !== null) {
      throw new EmailSendError('resend', `${error.name}: ${error.message}`);
    }
    return {
      id: data?.id,
      accepted: everyRecipient(message),
      transport: this.name,
    };
  }
}

/**
 * Resend rejects a key whose value is `undefined` as a type error rather than
 * ignoring it, so each optional field is added only when there is one.
 */
const payload = (message: OutboundEmail): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    from: formatAddress(message.from),
    to: message.to.map(formatAddress),
    subject: message.subject,
  };
  if (message.cc.length > 0) body['cc'] = message.cc.map(formatAddress);
  if (message.bcc.length > 0) body['bcc'] = message.bcc.map(formatAddress);
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
      content:
        typeof a.content === 'string'
          ? a.content
          : Buffer.from(a.content).toString('base64'),
      ...(a.contentType === undefined ? {} : { contentType: a.contentType }),
    }));
  }
  return body;
};
