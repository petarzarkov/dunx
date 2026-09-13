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
      rejected: [],
      transport: 'smtp',
    });
  });

  // A partial delivery is not a failure to retry: the message is already in the
  // accepted inboxes, and sending again puts a second copy there.
  it('reports a partial delivery rather than throwing', async () => {
    const stub = mailer({
      messageId: '<3@example.com>',
      accepted: ['a@example.com'],
      rejected: ['gone@example.com'],
    });

    const result = await new SmtpTransport({ mailer: stub }).send(outbound());

    expect(result.accepted).toEqual(['a@example.com']);
    expect(result.rejected).toEqual(['gone@example.com']);
  });

  it('throws only when every recipient was rejected', async () => {
    const stub = mailer({ accepted: [], rejected: ['a@example.com'] });

    await expect(
      new SmtpTransport({ mailer: stub }).send(outbound()),
    ).rejects.toThrow(/every recipient was rejected/);
  });

  it('treats a server that reports neither field as a total failure', async () => {
    await expect(
      new SmtpTransport({ mailer: mailer({}) }).send(outbound()),
    ).rejects.toThrow(EmailSendError);
  });

  it('verifies through nodemailer, and names its failure', async () => {
    const ok: SmtpMailer = {
      verify: () => Promise.resolve(true),
      sendMail: () => Promise.resolve({}),
    };
    const bad: SmtpMailer = {
      verify: () => Promise.reject(new Error('535 auth failed')),
      sendMail: () => Promise.resolve({}),
    };

    await expect(
      new SmtpTransport({ mailer: ok }).verify(),
    ).resolves.toBeUndefined();
    await expect(new SmtpTransport({ mailer: bad }).verify()).rejects.toThrow(
      /smtp refused the message: 535 auth failed/,
    );
  });

  // A stub, or a nodemailer build without it, has told the caller nothing.
  it('resolves when the mailer has no verify of its own', async () => {
    await expect(
      new SmtpTransport({ mailer: mailer() }).verify(),
    ).resolves.toBeUndefined();
  });

  it('wraps a rejected sendMail promise', async () => {
    const stub: SmtpMailer = {
      sendMail: () => Promise.reject(new Error('ECONNREFUSED')),
    };

    await expect(
      new SmtpTransport({ mailer: stub }).send(outbound()),
    ).rejects.toThrow(/smtp refused the message: ECONNREFUSED/);
  });
});
