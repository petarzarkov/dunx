import {
  Logger,
  DEFAULT_TRACE_FLAGS,
  mintSpanId,
  mintTraceId,
  NoopTracer,
  RequestContext,
  Tracer,
  within,
  type ActiveSpan,
  type RemoteParent,
  type RequestFields,
  type TraceIds,
} from '@dunx/core';
import { ConsumerStatus, type AsyncMessage } from 'rabbitmq-client';
import { remoteParentOf } from '../trace-carrier.js';
import type { DiscoveredSubscription } from './discover.js';
import { AmqpError, AmqpErrorCode } from './errors.js';
import { describeMessage } from './message.js';
import type { AmqpMessage } from './message.js';

/** What one handler's resolved settings are, once the meta is merged over the
 * module-wide defaults. `AmqpSubscriber` computes it; this reads it. */
export interface DispatchSettings {
  /** Return this delivery to the queue when the handler throws, rather than
   * dead-lettering or discarding it. */
  readonly requeue: boolean;
  readonly timeoutMs: number | undefined;
}

/**
 * Runs one handler for one delivery and decides what the broker is told, apart
 * from the thing that opens consumers so it is testable with no broker.
 *
 * **A throw never leaves here.** `rabbitmq-client` would nack it and emit `error`
 * on the consumer, which carries no message identity, so the failure would be
 * logged without saying which delivery failed.
 */
export class AmqpDispatcher {
  readonly #logger: Logger;
  readonly #context: RequestContext | undefined;
  /** Absent for the no-op, so an untraced delivery builds no span options. */
  readonly #tracer: Tracer | undefined;

  constructor(logger: Logger, context?: RequestContext, tracer?: Tracer) {
    this.#logger = logger;
    this.#context = context;
    this.#tracer = tracer instanceof NoopTracer ? undefined : tracer;
  }

  async dispatch(
    found: DiscoveredSubscription,
    settings: DispatchSettings,
    message: AsyncMessage,
  ): Promise<ConsumerStatus> {
    const subject = describeMessage(found.queue, message);
    // At warn, because a redelivery means an earlier attempt failed or a consumer
    // died holding it - a fact the line that ran the handler cannot carry.
    if (message.redelivered) {
      this.#logger.warn(`Redelivered AMQP message ${subject}`);
    }

    const run = async (span?: ActiveSpan): Promise<ConsumerStatus> => {
      try {
        const status = await this.#invoke(found, settings, message);
        this.#logger.debug(`Handled AMQP message ${subject}`);
        return typeof status === 'number' ? status : ConsumerStatus.ACK;
      } catch (error) {
        this.#logger.error(
          `AMQP handler ${found.provider}.${found.method}() failed on ` +
            `${subject}, ${settings.requeue ? 'requeueing' : 'dropping'} it`,
          error,
        );
        span?.recordError(error);
        return settings.requeue ? ConsumerStatus.REQUEUE : ConsumerStatus.DROP;
      }
    };

    const context = this.#context;
    const tracer = this.#tracer;
    if (context === undefined && tracer === undefined) return run();
    const inbound = remoteParentOf(message.headers ?? {});
    // Nothing encloses a delivery - the consumer callback runs off the broker's
    // socket, not inside a request - so there is no scope to inherit and
    // inheriting would only risk carrying a previous one in.
    const scoped = (span?: ActiveSpan): Promise<ConsumerStatus> =>
      context === undefined
        ? run(span)
        : context.runWithContext(
            this.#scope(found, inbound, span?.ids()),
            () => run(span),
            { inherit: false },
          );
    if (tracer === undefined) return scoped();

    return tracer.span(
      `process ${found.queue}`,
      {
        kind: 'consumer',
        attributes: {
          'messaging.system': 'rabbitmq',
          'messaging.operation.type': 'process',
          'messaging.operation.name': 'process',
          'messaging.destination.name': found.queue,
          ...(typeof message.messageId === 'string'
            ? { 'messaging.message.id': message.messageId }
            : {}),
        },
        ...(inbound === undefined ? {} : { parent: inbound }),
      },
      scoped,
    );
  }

  /**
   * The trace this delivery belongs to. The inbound trace is continued with a
   * span of this consumer's own, so the two services' log lines join; a message
   * without one starts a trace here. A recording `span` supplies the ids.
   */
  #scope(
    found: DiscoveredSubscription,
    inbound: RemoteParent | undefined,
    span?: TraceIds,
  ): RequestFields {
    return {
      flow: 'amqp',
      event: found.queue,
      context: `${found.provider}.${found.method}`,
      spanId: span?.spanId ?? mintSpanId(),
      ...(inbound === undefined
        ? {
            traceId: span?.traceId ?? mintTraceId(),
            traceFlags: span?.flags ?? DEFAULT_TRACE_FLAGS,
          }
        : {
            traceId: span?.traceId ?? inbound.traceId,
            parentSpanId: inbound.spanId,
            traceFlags: span?.flags ?? inbound.flags,
            ...(inbound.state === undefined
              ? {}
              : { traceState: inbound.state }),
          }),
    };
  }

  #invoke(
    found: DiscoveredSubscription,
    settings: DispatchSettings,
    message: AsyncMessage,
  ): unknown {
    const delivery = message as AmqpMessage;
    const { timeoutMs } = settings;
    if (timeoutMs === undefined) return found.handler(delivery);
    return within(
      Promise.try(() => found.handler(delivery)),
      timeoutMs,
      () => {
        throw new AmqpError(
          AmqpErrorCode.TIMED_OUT,
          `${found.provider}.${found.method}() exceeded handlerTimeoutMs ` +
            `(${timeoutMs}ms) handling ${describeMessage(found.queue, delivery)}.`,
        );
      },
    );
  }
}
