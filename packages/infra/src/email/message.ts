import { InvalidAddressError, InvalidHeaderError } from './errors.js';

/**
 * A mailbox. The string form is either the address alone or `Name <address>`;
 * the object form carries the display name a provider renders beside it.
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
  /**
   * Addresses the provider refused while accepting the rest.
   *
   * A partial delivery is not a failure to be retried: the message is already in
   * the accepted inboxes, and sending again puts a second copy there. It is
   * reported rather than thrown so a caller can act on the difference.
   */
  readonly rejected: readonly string[];
  /** Which transport handled it. `'log'` means nothing left the process. */
  readonly transport: string;
}

/**
 * `Name <addr>` as one string, which is how a sender is usually configured and
 * what a bare `{ address }` would otherwise carry whole into the address slot.
 */
const MAILBOX = /^\s*(.*?)\s*<([^<>]*)>\s*$/;

/**
 * What may never reach a header. A newline starts one, a comma or a semicolon
 * starts a second recipient once SMTP joins the list, and angle brackets close
 * the mailbox early. None of these can be escaped into meaning what was written.
 */
const UNSAFE_ADDRESS = /[\r\n\0,;<>]/;
const UNSAFE_NAME = /[\r\n\0]/;

/**
 * Refuses a newline in anything that becomes a header. The subject is one, and
 * so is every entry in `headers`: both reach a provider verbatim, and a CR or
 * LF in either starts a header the caller never wrote.
 */
export const assertHeaderSafe = (field: string, value: string): void => {
  if (UNSAFE_NAME.test(value)) throw new InvalidHeaderError(field);
};

const checked = (address: string, name: string | undefined): EmailAddress => {
  if (address === '') throw new InvalidAddressError(address, 'it is empty');
  if (UNSAFE_ADDRESS.test(address)) {
    throw new InvalidAddressError(
      address,
      'it carries a newline, a comma, a semicolon or an angle bracket',
    );
  }
  if (!address.includes('@')) {
    throw new InvalidAddressError(address, 'it has no "@"');
  }
  if (name !== undefined && UNSAFE_NAME.test(name)) {
    throw new InvalidAddressError(
      address,
      'its display name carries a newline',
    );
  }
  return name === undefined ? { address } : { address, name };
};

/** Strips the quoting {@link formatAddress} adds, so a round trip is stable. */
const unquote = (name: string): string | undefined => {
  const bare = /^"(.*)"$/.exec(name)?.[1] ?? name;
  const unescaped = bare.replace(/\\(["\\])/g, '$1');
  return unescaped === '' ? undefined : unescaped;
};

/**
 * Normalises a recipient and refuses one that cannot be put in a header.
 *
 * Validation lives here rather than at each call site because this is the one
 * function every recipient on every field goes through.
 */
export const toAddress = (recipient: EmailRecipient): EmailAddress => {
  if (typeof recipient !== 'string') {
    return checked(recipient.address, recipient.name);
  }
  const match = MAILBOX.exec(recipient);
  return match === null
    ? checked(recipient, undefined)
    : checked(match[2] ?? '', unquote(match[1] ?? ''));
};

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
