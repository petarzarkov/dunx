import { describe, expect, it } from 'bun:test';
import { EmailSendError } from '../errors.js';
import { outbound } from '../outbound.fixture.js';
import { SmtpTransport, type SmtpMailer } from './index.js';

const mailer = (
  answer: Awaited<ReturnType<SmtpMailer['sendMail']>> = {
    messageId: '<1@example.com>',
    accepted: ['a@example.com'],
    rejected: [],
  },
): SmtpMailer & { payloads: Record<string, unknown>[] } => {
  const payloads: Record<string, unknown>[] = [];
  return {
    payloads,
    sendMail(payload) {
      payloads.push(payload);
      return Promise.resolve(answer);
    },
  };
};

describe('SmtpTransport', () => {
  it('needs a url, a transport config or a mailer', () => {
    expect(() => new SmtpTransport({})).toThrow(EmailSendError);
  });

  // A caller reading the url off configuration writes `url: smtpUrl ?? ''`, and
  // an empty one used to reach nodemailer and fail with its error, not this one.
  it('treats an empty url as no url', () => {
    expect(() => new SmtpTransport({ url: '' })).toThrow(
      /needs a url, a transport config or a mailer/,
    );
  });

  it('builds a transporter from a url', () => {
    expect(new SmtpTransport({ url: 'smtp://localhost:2525' }).name).toBe(
      'smtp',
    );
  });

  it('builds a transporter from a config object', () => {
    const transport = new SmtpTransport({
      transport: { host: 'localhost', port: 2525 },
    });

    expect(transport.name).toBe('smtp');
  });

  it('joins recipients into the comma lists nodemailer expects', async () => {
    const stub = mailer();

    await new SmtpTransport({ mailer: stub }).send(
      outbound({
        to: [{ address: 'a@example.com' }, { address: 'b@example.com' }],
        cc: [{ address: 'c@example.com' }],
        bcc: [{ address: 'd@example.com' }],
        replyTo: { address: 'r@example.com' },
        headers: { 'X-Entity': 'invoice' },
        attachments: [{ filename: 'a.txt', content: 'hello' }],
      }),
    );

    expect(stub.payloads[0]).toEqual({
      from: '"Ops" <ops@example.com>',
      to: 'a@example.com, b@example.com',
      cc: 'c@example.com',
      bcc: 'd@example.com',
      replyTo: 'r@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
      headers: { 'X-Entity': 'invoice' },
      attachments: [{ filename: 'a.txt', content: 'hello' }],
    });
  });

  it('omits every optional field for a minimum message', async () => {
    const stub = mailer();

    await new SmtpTransport({ mailer: stub }).send(
      outbound({ html: undefined, text: undefined }),
    );

    expect(stub.payloads[0]).toEqual({
      from: '"Ops" <ops@example.com>',
      to: 'a@example.com',
      subject: 'Hi',
    });
  });

  // The server's answer is the honest one and can be shorter than what was
  // asked for, so `accepted` is read back rather than assumed.
  it('reports what the server accepted', async () => {
    const stub = mailer({
      messageId: '<2@example.com>',
      accepted: ['a@example.com', { address: 'b@example.com' }],
      rejected: [],
    });

    const result = await new SmtpTransport({ mailer: stub }).send(outbound());

    expect(result).toEqual({
      id: '<2@example.com>',
      accepted: ['a@example.com', 'b@example.com'],
      transport: 'smtp',
    });
  });

  it('copes with a server that reports neither field', async () => {
    const result = await new SmtpTransport({ mailer: mailer({}) }).send(
      outbound(),
    );

    expect(result).toEqual({ id: undefined, accepted: [], transport: 'smtp' });
  });

  it('throws when the server rejected a recipient', async () => {
    const stub = mailer({ accepted: [], rejected: ['a@example.com'] });

    await expect(
      new SmtpTransport({ mailer: stub }).send(outbound()),
    ).rejects.toThrow(/1 recipient\(s\) rejected/);
  });
});
