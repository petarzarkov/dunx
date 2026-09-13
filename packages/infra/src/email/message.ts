/**
 * A mailbox. The string form is the address alone; the object form carries the
 * display name a provider renders beside it.
 */
export interface EmailAddress {
  readonly address: string;
  readonly name?: string | undefined;
}

export type EmailRecipient = string | EmailAddress;

export interface EmailAttachment {
  readonly filename: string;
  readonly content: string | Uint8Array;
  /** Derived from the filename by the transport when absent. */
  readonly contentType?: string | undefined;
}

/** What a caller hands `EmailService.send`. */
export interface EmailMessage {
  readonly to: EmailRecipient | readonly EmailRecipient[];
  readonly subject: string;
  /** Defaults to the `from` the module was configured with. */
  readonly from?: EmailRecipient | undefined;
  readonly cc?: EmailRecipient | readonly EmailRecipient[] | undefined;
  readonly bcc?: EmailRecipient | readonly EmailRecipient[] | undefined;
  readonly replyTo?: EmailRecipient | undefined;
  readonly html?: string | undefined;
  readonly text?: string | undefined;
  readonly attachments?: readonly EmailAttachment[] | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

/**
 * The same message with the module's defaults applied and every recipient in
 * object form. A transport receives this rather than {@link EmailMessage}, so
 * `from` is present by type and no transport repeats the defaulting.
 */
export interface OutboundEmail {
  readonly from: EmailAddress;
  readonly to: readonly EmailAddress[];
  readonly subject: string;
  readonly cc: readonly EmailAddress[];
  readonly bcc: readonly EmailAddress[];
  readonly replyTo: EmailAddress | undefined;
  readonly html: string | undefined;
  readonly text: string | undefined;
  readonly attachments: readonly EmailAttachment[];
  readonly headers: Readonly<Record<string, string>>;
}

export interface EmailResult {
  /** The provider's own id, when it returns one. */
  readonly id: string | undefined;
  /** Addresses the transport accepted: `to` plus `cc` plus `bcc`. */
  readonly accepted: readonly string[];
  /** Which transport handled it. `'log'` means nothing left the process. */
  readonly transport: string;
}

export const toAddress = (recipient: EmailRecipient): EmailAddress =>
  typeof recipient === 'string' ? { address: recipient } : recipient;

export const toAddressList = (
  recipients: EmailRecipient | readonly EmailRecipient[] | undefined,
): readonly EmailAddress[] => {
  if (recipients === undefined) return [];
  const list = Array.isArray(recipients)
    ? (recipients as readonly EmailRecipient[])
    : [recipients as EmailRecipient];
  return list.map(toAddress);
};

/**
 * RFC 5322 `"Name" <address>`, or the bare address when there is no name. The
 * name is quoted and its own quotes and backslashes escaped, so a display name
 * carrying a comma or an angle bracket cannot forge a second recipient.
 */
export const formatAddress = (recipient: EmailRecipient): string => {
  const { address, name } = toAddress(recipient);
  if (name === undefined || name === '') return address;
  return `"${name.replace(/["\\]/g, '\\$&')}" <${address}>`;
};

export const everyRecipient = (message: OutboundEmail): readonly string[] =>
  [...message.to, ...message.cc, ...message.bcc].map((a) => a.address);
