import type { ResilienceOptionsInit } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { Quiet } from '../quiet.fixture.js';
import {
  EmailSendError,
  InvalidHeaderError,
  MissingRecipientError,
  MissingSenderError,
} from './errors.js';
import { MemoryTransport } from './memory.js';
import type { EmailResult, OutboundEmail } from './message.js';
import { EmailOptions, type EmailOptionsInit } from './options.js';
import {
  TemplateRenderer,
  UnconfiguredRenderer,
  type RenderedEmail,
} from './renderer.js';
import { EmailService } from './service.js';
import { EmailTransport } from './transport.js';

class Upper extends TemplateRenderer<string> {
  render(
    template: string,
    props: Record<string, unknown> = {},
  ): Promise<RenderedEmail> {
    const name = typeof props['name'] === 'string' ? props['name'] : '';
    return Promise.resolve({
      html: `<p>${template.toUpperCase()} ${name}</p>`,
      text: `${template} ${name}`,
    });
  }

  override previewProps(): Record<string, unknown> {
    return { name: 'sample' };
  }
}

class Flaky extends EmailTransport {
  readonly name = 'flaky';
  attempts = 0;

  constructor(private readonly failures: number) {
    super();
  }

  send(message: OutboundEmail): Promise<EmailResult> {
    this.attempts += 1;
    if (this.attempts <= this.failures) {
      return Promise.reject(new EmailSendError('flaky', 'rate limited'));
    }
    return Promise.resolve({
      id: 'ok',
      accepted: message.to.map((a) => a.address),
      rejected: [],
      transport: this.name,
    });
  }
}

const build = (
  init: EmailOptionsInit = {},
  transport: EmailTransport = new MemoryTransport(),
  renderer: TemplateRenderer = new UnconfiguredRenderer(),
): EmailService =>
  new EmailService(
    new EmailOptions({ from: 'ops@example.com', ...init }),
    transport,
    renderer,
    new Quiet(),
  );

describe('EmailService.resolve', () => {
  it('applies the module sender and normalises every recipient', () => {
    const outbound = build().resolve({
      to: 'a@example.com',
      cc: ['b@example.com'],
      subject: 'Hi',
    });

    expect(outbound.from).toEqual({ address: 'ops@example.com' });
    expect(outbound.to).toEqual([{ address: 'a@example.com' }]);
    expect(outbound.cc).toEqual([{ address: 'b@example.com' }]);
    expect(outbound.bcc).toEqual([]);
    expect(outbound.attachments).toEqual([]);
    expect(outbound.headers).toEqual({});
    expect(outbound.replyTo).toBeUndefined();
  });

  it('lets the message override the sender and the reply-to', () => {
    const service = build({ replyTo: 'support@example.com' });

    const outbound = service.resolve({
      to: 'a@example.com',
      subject: 'Hi',
      from: { address: 'billing@example.com', name: 'Billing' },
      replyTo: 'nobody@example.com',
    });

    expect(outbound.from).toEqual({
      address: 'billing@example.com',
      name: 'Billing',
    });
    expect(outbound.replyTo).toEqual({ address: 'nobody@example.com' });
  });

  it('falls back to the module reply-to', () => {
    const outbound = build({ replyTo: 'support@example.com' }).resolve({
      to: 'a@example.com',
      subject: 'Hi',
    });

    expect(outbound.replyTo).toEqual({ address: 'support@example.com' });
  });

  it('refuses a message with no sender anywhere', () => {
    const service = new EmailService(
      new EmailOptions(),
      new MemoryTransport(),
      new UnconfiguredRenderer(),
      new Quiet(),
    );

    expect(() =>
      service.resolve({ to: 'a@example.com', subject: 'Hi' }),
    ).toThrow(MissingSenderError);
  });

  // The subject is a header too, and so is every entry in `headers`. Validating
  // the addresses and stopping there left the commonest injection open: a name
  // interpolated into a subject.
  it('refuses a newline in the subject', () => {
    expect(() =>
      build().resolve({
        to: 'a@example.com',
        subject: 'Welcome\r\nBcc: evil@attacker.com',
      }),
    ).toThrow(InvalidHeaderError);
  });

  it('refuses a newline in a header name or value', () => {
    expect(() =>
      build().resolve({
        to: 'a@example.com',
        subject: 'Hi',
        headers: { 'X-Entity': 'invoice\nBcc: evil@attacker.com' },
      }),
    ).toThrow(InvalidHeaderError);
    expect(() =>
      build().resolve({
        to: 'a@example.com',
        subject: 'Hi',
        headers: { 'X\r\nBcc': 'invoice' },
      }),
    ).toThrow(InvalidHeaderError);
  });

  it('carries a 400 and names the field', () => {
    const error = new InvalidHeaderError('the subject');

    expect(error.status).toBe(400);
    expect(error.message).toContain('the subject');
  });

  it('refuses a message with no recipient on any field', () => {
    expect(() => build().resolve({ to: [], subject: 'Hi' })).toThrow(
      MissingRecipientError,
    );
  });
});

describe('EmailService.send', () => {
  it('hands the resolved message to the transport', async () => {
    const transport = new MemoryTransport();
    const result = await build({}, transport).send({
      to: 'a@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
    });

    expect(result.transport).toBe('memory');
    expect(result.accepted).toEqual(['a@example.com']);
    expect(transport.last?.subject).toBe('Hi');
    expect(transport.last?.from.address).toBe('ops@example.com');
  });

  it('does not retry by default', async () => {
    const transport = new Flaky(1);

    await expect(
      build({}, transport).send({ to: 'a@example.com', subject: 'Hi' }),
    ).rejects.toThrow(EmailSendError);
    expect(transport.attempts).toBe(1);
  });

  /**
   * The table that caught the bug. `resilience` used to be spread whole over
   * `{ retry: { maxRetries: 0 } }`, so naming any key inside `retry` replaced
   * the object and took the zero with it: tuning only a delay turned retries on
   * and put a second email in a real inbox. Only an explicit `maxRetries` may
   * raise it.
   */
  const RESILIENCE: readonly [string, ResilienceOptionsInit, number][] = [
    ['nothing configured', {}, 1],
    ['a timeout only', { timeoutMs: 5_000 }, 1],
    ['a retry delay only', { retry: { retryDelayMs: 1 } }, 1],
    [
      'a backoff only',
      { retry: { backoff: { power: 2 }, retryDelayMs: 1 } },
      1,
    ],
    [
      'an explicit maxRetries',
      { retry: { maxRetries: 2, retryDelayMs: 1 } },
      3,
    ],
  ];

  it.each(RESILIENCE)(
    'attempts %s times for %s',
    async (_label, resilience, attempts) => {
      const transport = new Flaky(Number.POSITIVE_INFINITY);

      await build({ resilience }, transport)
        .send({ to: 'a@example.com', subject: 'Hi' })
        .catch(() => undefined);

      expect(transport.attempts).toBe(attempts);
    },
  );

  it('retries when the caller asks for it', async () => {
    const transport = new Flaky(2);

    const result = await build(
      { resilience: { retry: { maxRetries: 3, retryDelayMs: 1 } } },
      transport,
    ).send({ to: 'a@example.com', subject: 'Hi' });

    expect(result.id).toBe('ok');
    expect(transport.attempts).toBe(3);
  });

  it('paces the retries as well as the first attempt', async () => {
    const transport = new Flaky(1);
    const service = build(
      {
        maxPerSecond: 20,
        resilience: { retry: { maxRetries: 1, retryDelayMs: 1 } },
      },
      transport,
    );

    const started = performance.now();
    await service.send({ to: 'a@example.com', subject: 'Hi' });

    // The first attempt is free, the retry waits out the 50ms interval.
    expect(performance.now() - started).toBeGreaterThanOrEqual(45);
  });
});

describe('EmailService templates', () => {
  it('renders and sends in one call', async () => {
    const transport = new MemoryTransport();

    await build({}, transport, new Upper()).sendTemplate({
      to: 'a@example.com',
      subject: 'Hi',
      template: 'welcome',
      props: { name: 'Ada' },
    });

    expect(transport.last?.html).toBe('<p>WELCOME Ada</p>');
    expect(transport.last?.text).toBe('welcome Ada');
  });

  it('exposes the renderer on its own', async () => {
    const rendered = await build({}, new MemoryTransport(), new Upper()).render(
      'hello',
    );

    expect(rendered.html).toBe('<p>HELLO </p>');
  });

  it('names the fix when no renderer was configured', async () => {
    await expect(
      build().sendTemplate({
        to: 'a@example.com',
        subject: 'Hi',
        template: 'welcome',
      }),
    ).rejects.toThrow(/ReactEmailRenderer/);
  });
});
