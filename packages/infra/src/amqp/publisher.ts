import {
  formatTraceparent,
  Logger,
  NoopTracer,
  RequestContext,
  TRACEPARENT_HEADER,
  TRACESTATE_HEADER,
  traceparentOf,
  Tracer,
  type OnShutdown,
  type TraceIds,
} from '@dunx/core';
import type { Envelope, Publisher } from 'rabbitmq-client';
import { closeWithin } from '../close-within.js';
import { traceStateFor } from '../trace-carrier.js';
import { withTimeout } from '../with-timeout.js';
import { AmqpConnection } from './connection.js';
import { AmqpError, AmqpErrorCode } from './errors.js';
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
  /** Absent for the no-op, so an untraced publish builds no span options. */
  readonly #tracer: Tracer | undefined;
  #publisher: Publisher | undefined;

  constructor(
    connection: AmqpConnection,
    options: AmqpOptions,
    logger: Logger,
    context?: RequestContext,
    tracer?: Tracer,
  ) {
    this.#connection = connection;
    this.#options = options;
    this.#logger = logger;
    this.#context = context;
    this.#tracer = tracer instanceof NoopTracer ? undefined : tracer;
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
   * `send`, with this scope's trace stamped into the message headers, so the
   * consuming service continues it rather than starting its own. A bound tracer
   * wraps it in a PRODUCER span, whose ids a recording SDK stamps instead.
   *
   * `confirm` is on by default, so this resolves when the broker has accepted the
   * message rather than when the frame was written.
   *
   * **Bounded by `publishTimeoutMs`, and the bound is on the wait rather than on
   * the send.** `rabbitmq-client` retries an unreachable broker instead of
   * failing, so without it this settles in neither direction and a route
   * publishing inside a request hangs that request. A send that outran the bound
   * is still in flight, so a caller that retries can put the message on the
   * broker twice - the same trade `handlerTimeoutMs` documents.
   */
  publish<T>(envelope: string | Envelope, body: T): Promise<void> {
    const addressed: Envelope =
      typeof envelope === 'string' ? { routingKey: envelope } : envelope;
    const tracer = this.#tracer;
    if (tracer === undefined) return this.#send(this.#traced(addressed), body);

    // The default exchange routes by queue name, so that is the destination.
    const destination = addressed.exchange || addressed.routingKey || '';
    return tracer.span(
      `publish ${destination}`,
      {
        kind: 'producer',
        attributes: {
          'messaging.system': 'rabbitmq',
          'messaging.operation.type': 'send',
          'messaging.operation.name': 'publish',
          'messaging.destination.name': destination,
          ...(addressed.exchange && addressed.routingKey
            ? {
                'messaging.rabbitmq.destination.routing_key':
                  addressed.routingKey,
              }
            : {}),
        },
      },
      (span) => this.#send(this.#traced(addressed, span.ids()), body),
    );
  }

  async #send<T>(stamped: Envelope, body: T): Promise<void> {
    const { publishTimeoutMs } = this.#options;

    await withTimeout(
      () => this.publisher().send(stamped, body),
      publishTimeoutMs,
      () =>
        new AmqpError(
          AmqpErrorCode.PUBLISH_TIMED_OUT,
          `The publish to ${this.#addressOf(stamped)} did not confirm within ` +
            `${publishTimeoutMs} ms. Broker ${this.#options.redactedUrl}.`,
        ),
    );
    this.#logger.debug(`Published AMQP message to ${this.#addressOf(stamped)}`);
  }

  /** `exchange[routingKey]`, the form the warnings above already use. */
  #addressOf(envelope: Envelope): string {
    return `${envelope.exchange ?? ''}[${envelope.routingKey ?? ''}]`;
  }

  /**
   * The envelope with `traceparent` and `tracestate` added.
   *
   * **The two are one context, so they are stamped together or not at all.** A
   * caller that set `traceparent` alone is forwarding an upstream trace, and
   * adding this scope's `tracestate` to it would join the vendor state of one
   * trace to the ids of another.
   *
   * `span` is a recording producer span's ids, which replace the scope's own,
   * and take the scope's `tracestate` only when the two are on one trace.
   */
  #traced(envelope: Envelope, span?: TraceIds): Envelope {
    const headers = envelope.headers ?? {};
    if (TRACEPARENT_HEADER in headers || TRACESTATE_HEADER in headers) {
      return envelope;
    }

    const fields = this.#context?.getContext();
    const traceparent =
      span === undefined
        ? fields === undefined
          ? undefined
          : traceparentOf(fields)
        : formatTraceparent(span);
    if (traceparent === undefined) return envelope;
    const state =
      fields === undefined || span === undefined
        ? fields?.traceState
        : traceStateFor(span, fields);

    return {
      ...envelope,
      headers: {
        ...headers,
        [TRACEPARENT_HEADER]: traceparent,
        ...(state === undefined ? {} : { [TRACESTATE_HEADER]: state }),
      },
    };
  }

  /**
   * Closes the channel, before the socket it borrowed closes under it.
   *
   * Bounded by `closeTimeoutMs`, for the reason the consumer drain is: closing a
   * channel needs the connection, so against a broker that has gone away this
   * waits `acquireTimeout`, measured at 20 s on rabbitmq-client 5.0.8. Teardown
   * is sequential, so an unbounded wait here ran before `AmqpConnection`'s own
   * bound and its `unsafeDestroy()`, and `SIGTERM` hung past both.
   */
  async onShutdown(): Promise<void> {
    const publisher = this.#publisher;
    if (publisher === undefined) return;
    this.#publisher = undefined;

    try {
      const timedOut = await closeWithin(
        publisher,
        this.#options.closeTimeoutMs,
      );
      if (timedOut) {
        this.#logger.warn(
          'the AMQP publisher did not close within ' +
            `${this.#options.closeTimeoutMs} ms`,
        );
      }
    } catch (error) {
      this.#logger.warn('the AMQP publisher failed to close', error);
    }
  }
}
