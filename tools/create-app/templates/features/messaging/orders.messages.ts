import { Logger, RequestContext } from '@dunx/core';
import { AmqpHandler, type AmqpMessage } from '@dunx/infra/amqp';

/** The exchange this app owns, and the two queues bound to it. */
export const ORDERS_EXCHANGE = 'dunx-full.orders';
export const PLACED_QUEUE = 'dunx-full.orders.placed';
export const SHIPPED_QUEUE = 'dunx-full.orders.shipped';

export const PLACED_KEY = 'order.placed';
export const SHIPPED_KEY = 'order.shipped';

export interface OrderPlaced {
  readonly id: string;
  readonly total: number;
}

export interface Handled {
  readonly id: string;
  readonly queue: string;
  /** The trace the publisher was in, read back from the message headers. */
  readonly traceId: string | undefined;
}

/**
 * Two handlers, one per queue, on one topic exchange. Both are methods with a
 * decorator and nothing else: no registry, no class decorator, no broker token.
 * Discovery walks the prototypes of the classes already in `providers`, the same
 * marker-plus-scan `@JobHandler` and the routes use.
 */
export class OrdersMessages {
  /** What arrived, so an HTTP route can show the consuming side worked. */
  readonly handled: Handled[] = [];

  constructor(
    private readonly logger: Logger,
    private readonly context: RequestContext,
  ) {}

  @AmqpHandler({
    queue: PLACED_QUEUE,
    exchange: ORDERS_EXCHANGE,
    routingKey: PLACED_KEY,
  })
  async onPlaced(message: AmqpMessage<OrderPlaced>): Promise<void> {
    this.record(PLACED_QUEUE, message.body.id);
    this.logger.info(
      `order ${message.body.id} placed for ${message.body.total}`,
    );
  }

  /**
   * `requeue: false` sends a throwing delivery to this queue's dead-letter
   * exchange if one is configured, and discards it otherwise. The default puts it
   * straight back, which loops on a payload that can never succeed.
   */
  @AmqpHandler({
    queue: SHIPPED_QUEUE,
    exchange: ORDERS_EXCHANGE,
    routingKey: SHIPPED_KEY,
    consumer: { concurrency: 2, requeue: false },
  })
  async onShipped(message: AmqpMessage<OrderPlaced>): Promise<void> {
    this.record(SHIPPED_QUEUE, message.body.id);
    this.logger.info(`order ${message.body.id} shipped`);
  }

  private record(queue: string, id: string): void {
    this.handled.push({
      id,
      queue,
      // Stamped by `AmqpPublisher.publish` and continued here, so the HTTP
      // request that sent this and the handler that ran share a traceId.
      traceId: this.context.getContext().traceId,
    });
  }
}
