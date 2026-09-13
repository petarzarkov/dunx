import { Logger, ResiliencePolicy } from '@dunx/core';
import { MissingRecipientError, MissingSenderError } from './errors.js';
import {
  assertHeaderSafe,
  everyRecipient,
  toAddress,
  toAddressList,
  type EmailMessage,
  type EmailResult,
  type OutboundEmail,
} from './message.js';
import { EmailOptions } from './options.js';
import { SendPacer } from './pacer.js';
import { TemplateRenderer, type RenderedEmail } from './renderer.js';
import { EmailTransport } from './transport.js';

/** A message whose bodies come from a template rather than from strings. */
export interface TemplateEmail extends Omit<EmailMessage, 'html' | 'text'> {
  readonly template: unknown;
  readonly props?: Record<string, unknown> | undefined;
}

/**
 * What an app injects to send mail.
 *
 * It owns the four things every app otherwise rewrites: the default sender, the
 * per-second pacing, the retry policy around one send, and the rendering call.
 * What it does not own is the provider, which is whatever {@link EmailTransport}
 * the module bound.
 */
export class EmailService {
  readonly #pacer: SendPacer;
  readonly #policy: ResiliencePolicy;

  constructor(
    private readonly options: EmailOptions,
    private readonly transport: EmailTransport,
    private readonly renderer: TemplateRenderer,
    private readonly logger: Logger,
  ) {
    this.#pacer = new SendPacer(options.maxPerSecond);
    this.#policy = new ResiliencePolicy(options.resilience);
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    const outbound = this.resolve(message);
    // The pacer sits inside the policy, so a retry is spaced like a first
    // attempt rather than firing straight into the cap that rejected it.
    const result = await this.#policy.run(async () => {
      await this.#pacer.wait();
      return this.transport.send(outbound);
    });
    // The bodies are deliberately not logged here: the message went somewhere,
    // and `LogTransport` is what exists for reading one that did not.
    this.logger.debug('email sent', {
      transport: result.transport,
      id: result.id,
      subject: outbound.subject,
    });
    return result;
  }

  /** Renders `template` with `props`, then sends the result. */
  async sendTemplate(message: TemplateEmail): Promise<EmailResult> {
    const { template, props, ...rest } = message;
    const rendered = await this.render(template, props);
    return this.send({ ...rest, html: rendered.html, text: rendered.text });
  }

  /** The configured renderer, exposed so a preview or a test can call it. */
  render(
    template: unknown,
    props?: Record<string, unknown>,
  ): Promise<RenderedEmail> {
    return this.renderer.render(template, props);
  }

  /**
   * Applies the module's defaults and normalises every recipient. Separate from
   * `send` so a caller can see exactly what a transport would receive, which is
   * what the dry-run log line and the tests assert against.
   */
  resolve(message: EmailMessage): OutboundEmail {
    const from = message.from ?? this.options.from;
    if (from === undefined) throw new MissingSenderError();
    const replyTo = message.replyTo ?? this.options.replyTo;
    // The subject and every header reach a provider verbatim, so both go
    // through the same newline check the addresses do.
    assertHeaderSafe('the subject', message.subject);
    for (const [name, value] of Object.entries(message.headers ?? {})) {
      assertHeaderSafe(`the header ${name}`, name);
      assertHeaderSafe(`the header ${name}`, value);
    }
    const outbound: OutboundEmail = {
      from: toAddress(from),
      to: toAddressList(message.to),
      subject: message.subject,
      cc: toAddressList(message.cc),
      bcc: toAddressList(message.bcc),
      replyTo: replyTo === undefined ? undefined : toAddress(replyTo),
      html: message.html,
      text: message.text,
      attachments: message.attachments ?? [],
      headers: message.headers ?? {},
    };
    if (everyRecipient(outbound).length === 0) {
      throw new MissingRecipientError();
    }
    return outbound;
  }
}
