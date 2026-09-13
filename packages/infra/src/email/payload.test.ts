import { describe, expect, it } from 'bun:test';
import type { EmailAddress, OutboundEmail } from './message.js';
import { outbound } from './outbound.fixture.js';
import { toPayload, withContentType } from './payload.js';

const shape = {
  recipients: (list: readonly EmailAddress[]) => list.map((a) => a.address),
  attachment: (file: { filename: string; content: string | Uint8Array }) =>
    withContentType(file, file.content),
};

/** Every optional field set, so nothing is absent for the wrong reason. */
const full = (): OutboundEmail =>
  outbound({
    cc: [{ address: 'c@example.com' }],
    bcc: [{ address: 'b@example.com' }],
    replyTo: { address: 'r@example.com' },
    headers: { 'X-Entity': 'invoice' },
    attachments: [{ filename: 'a.txt', content: 'hello' }],
  });

describe('toPayload', () => {
  /**
   * The guard the two hand-written builders did not have: a field added to
   * `OutboundEmail` and not handled here is dropped for every provider at once
   * and this fails, rather than dropped for one and noticed in production.
   */
  it('carries every field of a fully populated message', () => {
    const message = full();

    expect(Object.keys(toPayload(message, shape)).sort()).toEqual(
      Object.keys(message).sort(),
    );
  });

  it('omits every optional field that has no value', () => {
    const body = toPayload(
      outbound({ html: undefined, text: undefined }),
      shape,
    );

    expect(Object.keys(body).sort()).toEqual(['from', 'subject', 'to']);
  });

  // Resend rejects an explicit `undefined` rather than ignoring it, so absent
  // has to mean the key is not there at all.
  it('never writes an undefined value', () => {
    const body = toPayload(full(), shape);

    expect(Object.values(body).some((v) => v === undefined)).toBe(false);
  });

  it('renders the sender through formatAddress', () => {
    expect(toPayload(full(), shape)['from']).toBe('"Ops" <ops@example.com>');
  });
});

describe('withContentType', () => {
  it('adds the type only when the caller gave one', () => {
    expect(withContentType({ filename: 'a.txt', content: 'x' }, 'x')).toEqual({
      filename: 'a.txt',
      content: 'x',
    });
    expect(
      withContentType(
        { filename: 'a.txt', content: 'x', contentType: 'text/plain' },
        'x',
      ),
    ).toEqual({ filename: 'a.txt', content: 'x', contentType: 'text/plain' });
  });
});
