import type { OutboundEmail } from './message.js';

/**
 * A resolved message, so a transport suite states only the field it is about.
 * Here rather than in one suite because every transport needs the same one.
 */
export const outbound = (over: Partial<OutboundEmail> = {}): OutboundEmail => ({
  from: { address: 'ops@example.com', name: 'Ops' },
  to: [{ address: 'a@example.com' }],
  subject: 'Hi',
  cc: [],
  bcc: [],
  replyTo: undefined,
  html: '<p>Hi</p>',
  text: 'Hi',
  attachments: [],
  headers: {},
  ...over,
});
