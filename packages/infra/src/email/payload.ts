import {
  formatAddress,
  type EmailAddress,
  type EmailAttachment,
  type OutboundEmail,
} from './message.js';

/**
 * The two things providers disagree about: how a recipient list is rendered, and
 * how an attachment's bytes are carried. Everything else has the same key and
 * the same value on both.
 */
export interface PayloadShape {
  recipients(list: readonly EmailAddress[]): unknown;
  attachment(file: EmailAttachment): unknown;
}

/**
 * An {@link OutboundEmail} as a provider payload.
 *
 * One builder rather than one per transport. Both had the same walk over the
 * same optional fields, which meant adding a field to `OutboundEmail` was two
 * edits in lockstep and missing one dropped it silently for one provider.
 *
 * A key is present only when there is a value for it: an explicit `undefined` is
 * a type error to Resend rather than something it ignores.
 */
export const toPayload = (
  message: OutboundEmail,
  shape: PayloadShape,
): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    from: formatAddress(message.from),
    to: shape.recipients(message.to),
    subject: message.subject,
  };
  if (message.cc.length > 0) body['cc'] = shape.recipients(message.cc);
  if (message.bcc.length > 0) body['bcc'] = shape.recipients(message.bcc);
  if (message.replyTo !== undefined) {
    body['replyTo'] = formatAddress(message.replyTo);
  }
  if (message.html !== undefined) body['html'] = message.html;
  if (message.text !== undefined) body['text'] = message.text;
  if (Object.keys(message.headers).length > 0) {
    body['headers'] = message.headers;
  }
  if (message.attachments.length > 0) {
    body['attachments'] = message.attachments.map((file) =>
      shape.attachment(file),
    );
  }
  return body;
};

/** `contentType` only when the caller gave one, for the same reason. */
export const withContentType = (
  file: EmailAttachment,
  content: unknown,
): Record<string, unknown> => ({
  filename: file.filename,
  content,
  ...(file.contentType === undefined ? {} : { contentType: file.contentType }),
});
