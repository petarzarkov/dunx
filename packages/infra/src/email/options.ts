import {
  AppError,
  ResilienceOptions,
  type ResilienceOptionsInit,
} from '@dunx/core';
import {
  toAddress,
  type EmailAddress,
  type EmailRecipient,
} from './message.js';
import type { TemplateRenderer } from './renderer.js';
import type { EmailTransport } from './transport.js';

export interface EmailOptionsInit {
  /**
   * Where messages go. Absent means the log transport, so an app boots and is
   * testable with nothing configured.
   */
  readonly transport?: EmailTransport;
  /** The default sender. A message may name its own. */
  readonly from?: EmailRecipient;
  readonly replyTo?: EmailRecipient;
  /**
   * Send nowhere and log instead, keeping the configured transport in place so
   * flipping one boolean is the whole change between environments.
   */
  readonly dryRun?: boolean;
  /**
   * Provider cap. Sends start at most this often; `0` leaves them unpaced.
   * @default 0
   */
  readonly maxPerSecond?: number;
  /** Turns a template into the two bodies. @default UnconfiguredRenderer */
  readonly renderer?: TemplateRenderer;
  /**
   * Timeout, retry and backoff around one send.
   *
   * **Retries are off unless you ask for them.** A provider that accepted the
   * message and then lost the response is indistinguishable from one that never
   * saw it, and the cost of guessing wrong is a second email in a real person's
   * inbox. Turn them on for a provider whose 429 you trust to mean "not
   * accepted", which is what `maxPerSecond` is usually the better answer to.
   */
  readonly resilience?: ResilienceOptionsInit;
}

/**
 * The resolved options, as a class so it is both the injection token and the
 * type a factory annotates.
 */
export class EmailOptions {
  readonly transport: EmailTransport | undefined;
  readonly from: EmailAddress | undefined;
  readonly replyTo: EmailAddress | undefined;
  readonly dryRun: boolean;
  readonly maxPerSecond: number;
  readonly renderer: TemplateRenderer | undefined;
  readonly resilience: ResilienceOptions;

  constructor(init: EmailOptionsInit = {}) {
    const maxPerSecond = init.maxPerSecond ?? 0;
    if (!Number.isFinite(maxPerSecond) || maxPerSecond < 0) {
      throw new AppError(
        `Email maxPerSecond must be zero or a positive number, got ${String(maxPerSecond)}.`,
      );
    }
    this.transport = init.transport;
    this.from = init.from === undefined ? undefined : toAddress(init.from);
    this.replyTo =
      init.replyTo === undefined ? undefined : toAddress(init.replyTo);
    this.dryRun = init.dryRun ?? false;
    this.maxPerSecond = maxPerSecond;
    this.renderer = init.renderer;
    this.resilience = new ResilienceOptions({
      retry: { maxRetries: 0 },
      ...init.resilience,
    });
  }
}
