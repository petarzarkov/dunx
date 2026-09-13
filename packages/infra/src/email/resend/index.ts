import { Resend } from 'resend';
import { EmailSendError } from '../errors.js';
import {
  everyRecipient,
  formatAddress,
  type EmailResult,
  type OutboundEmail,
} from '../message.js';
import { toPayload, withContentType } from '../payload.js';
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

/** A list stays a list here, and bytes travel as base64. */
const payload = (message: OutboundEmail): Record<string, unknown> =>
  toPayload(message, {
    recipients: (list) => list.map(formatAddress),
    attachment: (file) =>
      withContentType(
        file,
        typeof file.content === 'string'
          ? file.content
          : Buffer.from(file.content).toString('base64'),
      ),
  });
