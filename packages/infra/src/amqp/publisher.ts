import {
  Logger,
  RequestContext,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  traceparentOf,
  type OnShutdown,
} from '@dunx/core';
import type { Envelope, Publisher } from 'rabbitmq-client';
import { AmqpConnection } from './connection.js';
import { AmqpOptions } from './options.js';

/**
 * Publishes messages. Nothing here knows how a message is handled, so a web
 * process imports this and opens no consumer.
 *
 * One `Publisher` on one channel, memoised. `rabbitmq-client` recreates it on
 * every reconnect and re-runs whatever `AmqpOptions.publisher` declares, so an
 * exchange this app owns is declared once rather than on every send.
 */
export class AmqpPublisher implements OnShutdown {
  readonly #connection: AmqpConnection;
  readonly #options: AmqpOptions;
  readonly #logger: Logger;
  readonly #context: RequestContext | undefined;
  #publisher: Publisher | undefined;

  constructor(
    connection: AmqpConnection,
    options: AmqpOptions,
    logger: Logger,
    context?: RequestContext,
  ) {
    this.#connection = connection;
    this.#options = options;
    this.#logger = logger;
    this.#context = context;
  }

  /** Whether a channel has been opened at all. */
  get opened(): boolean {
    return this.#publisher !== undefined;
  }

  /**
   * The `Publisher`, opened on first use. Going through it skips the trace
   * headers {@link publish} stamps.
   */
  publisher(): Publisher {
    const existing = this.#publisher;
    if (existing) return existing;

    const created = this.#connection.createPublisher(this.#options.publisher);
    // A publisher that exhausted `maxAttempts` emits rather than throwing, and an
    // 'error' event with no listener throws instead of being ignored.
    created.on('retry', (error: unknown) => {
      this.#logger.warn('retrying an AMQP publish', error);
    });
    created.on('basic.return', (message) => {
      this.#logger.warn(
        `the broker returned a message addressed to ` +
          `${message.exchange}[${message.routingKey}] as unroutable`,
      );
    });
    this.#publisher = created;
    return created;
  }

  /**
   * `send`, with this scope's trace stamped into the message headers. Without it
   * the consuming service starts a trace of its own and the two halves of one
   * flow never join; the subscriber reads the headers back.
   *
   * `confirm` is on by default, so this resolves when the broker has accepted the
   * message rather than when the frame was written.
   */
  async publish<T>(envelope: string | Envelope, body: T): Promise<void> {
    const addressed: Envelope =
      typeof envelope === 'string' ? { routingKey: envelope } : envelope;
    const stamped = this.#traced(addressed);

    await this.publisher().send(stamped, body);
    this.#logger.debug(
      `Published AMQP message to ${stamped.exchange ?? ''}[${stamped.routingKey ?? ''}]`,
    );
  }

  /** The envelope with `traceparent` and `tracestate` added. Neither overwrites
   * one the caller set, so forwarding passes the upstream trace on. */
  #traced(envelope: Envelope): Envelope {
    const fields = this.#context?.getContext();
    if (fields === undefined) return envelope;

    const traceparent = traceparentOf(fields);
    if (traceparent === undefined) return envelope;

    const headers = envelope.headers ?? {};
    return {
      ...envelope,
      headers: {
        ...headers,
        ...(TRACEPARENT_HEADER in headers
          ? {}
          : { [TRACEPARENT_HEADER]: traceparent }),
        ...(fields.traceState === undefined || TRACESTATE_HEADER in headers
          ? {}
          : { [TRACESTATE_HEADER]: fields.traceState }),
      },
    };
  }

  /** Closes the channel, before the socket it borrowed closes under it. */
  async onShutdown(): Promise<void> {
    const publisher = this.#publisher;
    if (publisher === undefined) return;
    this.#publisher = undefined;
    try {
      await publisher.close();
    } catch (error) {
      this.#logger.warn('the AMQP publisher failed to close', error);
    }
  }
}
