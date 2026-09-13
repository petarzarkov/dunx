import { describe, expect, it } from 'bun:test';
import { EmailSendError } from '../errors.js';
import { outbound } from '../outbound.fixture.js';
import { ResendTransport, type ResendClient } from './index.js';

const client = (
  answer: Awaited<ReturnType<ResendClient['emails']['send']>> = {
    data: { id: 're_1' },
    error: null,
  },
): ResendClient & { payloads: Record<string, unknown>[] } => {
  const payloads: Record<string, unknown>[] = [];
  return {
    payloads,
    emails: {
      send(payload) {
        payloads.push(payload);
        return Promise.resolve(answer);
      },
    },
  };
};

describe('ResendTransport', () => {
  it('needs a key or a client', () => {
    expect(() => new ResendTransport({})).toThrow(EmailSendError);
    expect(() => new ResendTransport({ apiKey: '' })).toThrow(EmailSendError);
  });

  it('builds a client from an api key', () => {
    expect(new ResendTransport({ apiKey: 're_test' }).name).toBe('resend');
  });

  it('sends the minimum payload for a minimum message', async () => {
    const stub = client();

    const result = await new ResendTransport({ client: stub }).send(
      outbound({ html: undefined, text: undefined }),
    );

    expect(result).toEqual({
      id: 're_1',
      accepted: ['a@example.com'],
      rejected: [],
      transport: 'resend',
    });
    expect(stub.payloads[0]).toEqual({
      from: '"Ops" <ops@example.com>',
      to: ['a@example.com'],
      subject: 'Hi',
    });
  });

  // Resend rejects an explicit `undefined` rather than ignoring it, so an
  // absent field has to be absent from the object and not merely unset.
  it('adds every optional field only when there is one', async () => {
    const stub = client();

    await new ResendTransport({ client: stub }).send(
      outbound({
        cc: [{ address: 'c@example.com' }],
        bcc: [{ address: 'b@example.com' }],
        replyTo: { address: 'r@example.com' },
        headers: { 'X-Entity': 'invoice' },
        attachments: [
          { filename: 'a.txt', content: 'hello', contentType: 'text/plain' },
          { filename: 'b.bin', content: new Uint8Array([1, 2, 3]) },
        ],
      }),
    );

    expect(stub.payloads[0]).toEqual({
      from: '"Ops" <ops@example.com>',
      to: ['a@example.com'],
      subject: 'Hi',
      cc: ['c@example.com'],
      bcc: ['b@example.com'],
      replyTo: 'r@example.com',
      html: '<p>Hi</p>',
      text: 'Hi',
      headers: { 'X-Entity': 'invoice' },
      attachments: [
        { filename: 'a.txt', content: 'aGVsbG8=', contentType: 'text/plain' },
        { filename: 'b.bin', content: 'AQID' },
      ],
    });
  });

  it('turns the provider error into an EmailSendError', async () => {
    const stub = client({
      data: null,
      error: { name: 'rate_limit_exceeded', message: 'Too many requests' },
    });

    await expect(
      new ResendTransport({ client: stub }).send(outbound()),
    ).rejects.toThrow(/rate_limit_exceeded: Too many requests/);
  });

  // A socket that never answered is this transport failing, like a refusal.
  it('wraps a rejected client promise', async () => {
    const stub: ResendClient = {
      emails: { send: () => Promise.reject(new Error('ECONNRESET')) },
    };

    await expect(
      new ResendTransport({ client: stub }).send(outbound()),
    ).rejects.toThrow(/resend refused the message: ECONNRESET/);
  });

  it('has no id when the provider returns none', async () => {
    const stub = client({ data: null, error: null });

    const result = await new ResendTransport({ client: stub }).send(outbound());

    expect(result.id).toBeUndefined();
  });
});
