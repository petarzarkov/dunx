import { Logger, RequestContext } from '@dunx/core';
import { AmqpHandler, type AmqpMessage } from '@dunx/infra/amqp';
import { ConsumerStatus } from 'rabbitmq-client';
import { z } from 'zod';

/** The exchange this app owns, and the two queues bound to it. */
export const ORDERS_EXCHANGE = 'dunx-full.orders';
export const PLACED_QUEUE = 'dunx-full.orders.placed';
export const SHIPPED_QUEUE = 'dunx-full.orders.shipped';

export const PLACED_KEY = 'order.placed';
export const SHIPPED_KEY = 'order.shipped';

/**
 * `AmqpMessage<T>` is a compile-time shape. Nothing validates what the broker
 * actually delivered, and a body from an older producer - or from anything else
 * that can reach the exchange - arrives as whatever it is.
 */
const OrderPlaced = z.object({
  id: z.string().min(1),
  total: z.number(),
});

export type OrderPlaced = z.infer<typeof OrderPlaced>;

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
/**
 * How many deliveries `handled` keeps. `consume: true` means this runs for the
 * life of the process, so an unbounded array is a slow leak rather than a record.
 */
const KEEP = 100;

export class OrdersMessages {
  /** The most recent deliveries, so an HTTP route can show the consuming side
   * worked. Oldest first, capped at {@link KEEP}. */
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
  async onPlaced(
    message: AmqpMessage<unknown>,
  ): Promise<ConsumerStatus | void> {
    const order = this.parse(message.body);
    // A body that can never parse is dropped rather than thrown: this queue
    // takes the default `requeue: true`, so throwing would redeliver it forever.
    // A throw is still the right answer for a failure that might succeed later.
    if (order === undefined) return ConsumerStatus.DROP;

    this.record(PLACED_QUEUE, order.id);
    this.logger.info(`order ${order.id} placed for ${order.total}`);
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
  async onShipped(
    message: AmqpMessage<unknown>,
  ): Promise<ConsumerStatus | void> {
    const order = this.parse(message.body);
    if (order === undefined) return ConsumerStatus.DROP;

    this.record(SHIPPED_QUEUE, order.id);
    this.logger.info(`order ${order.id} shipped`);
  }

  /** The body, or nothing when it is not an order. */
  private parse(body: unknown): OrderPlaced | undefined {
    const parsed = OrderPlaced.safeParse(body);
    if (parsed.success) return parsed.data;
    this.logger.warn(
      `dropping a delivery that is not an order: ${parsed.error.message}`,
    );
    return undefined;
  }

  private record(queue: string, id: string): void {
    if (this.handled.length >= KEEP) this.handled.shift();
    this.handled.push({
      id,
      queue,
      // Stamped by `AmqpPublisher.publish` and continued here, so the HTTP
      // request that sent this and the handler that ran share a traceId.
      traceId: this.context.getContext().traceId,
    });
  }
}
