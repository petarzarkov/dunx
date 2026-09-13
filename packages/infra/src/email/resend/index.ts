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
    // A refusal comes back as `error`, but a socket that never answered comes
    // back as a rejection. Both are this transport failing, so both leave it as
    // the same error rather than one of them as a `resend` internal.
    let answer;
    try {
      answer = await this.#client.emails.send(payload(message));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new EmailSendError('resend', detail, { cause });
    }
    const { data, error } = answer;
    if (error !== null) {
      throw new EmailSendError('resend', `${error.name}: ${error.message}`);
    }
    return {
      id: data?.id,
      accepted: everyRecipient(message),
      rejected: [],
      transport: this.name,
    };
  }
}

/**
 * A list stays a list here, and every attachment travels as base64.
 *
 * A string is encoded too, rather than assumed to be base64 already: the SDK
 * copies `content` into the request and `JSON.stringify`s it, so a plain
 * `'hello'` arrives as an attachment of the four bytes that decode from it.
 */
const payload = (message: OutboundEmail): Record<string, unknown> =>
  toPayload(message, {
    recipients: (list) => list.map(formatAddress),
    attachment: (file) =>
      withContentType(file, Buffer.from(file.content).toString('base64')),
  });
