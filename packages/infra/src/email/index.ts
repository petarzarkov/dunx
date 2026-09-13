export {
  EmailError,
  EmailSendError,
  InvalidAddressError,
  MissingRecipientError,
  MissingSenderError,
} from './errors.js';
export { LogTransport } from './log.js';
export { MemoryTransport } from './memory.js';
export {
  everyRecipient,
  formatAddress,
  toAddress,
  toAddressList,
  type EmailAddress,
  type EmailAttachment,
  type EmailMessage,
  type EmailRecipient,
  type EmailResult,
  type OutboundEmail,
} from './message.js';
export { EmailModule } from './module.js';
export { EmailOptions, type EmailOptionsInit } from './options.js';
// For a transport outside this package: the same walk both shipped ones take, so
// a field added to `OutboundEmail` reaches every provider at once.
export { toPayload, withContentType, type PayloadShape } from './payload.js';
export { SendPacer } from './pacer.js';
export { EmailPreview, type PreviewOptions } from './preview.js';
// `TemplateRenderer` and `EmailTransport` are the tokens to inject, and both are
// abstract classes, which is what makes them nameable as constructor parameter
// types - see @dunx/transform.
export {
  TemplateRenderer,
  UnconfiguredRenderer,
  type RenderedEmail,
} from './renderer.js';
export { EmailService, type TemplateEmail } from './service.js';
export {
  discoverTemplates,
  loadTemplate,
  type TemplateEntry,
} from './templates.js';
export { EmailTransport } from './transport.js';
