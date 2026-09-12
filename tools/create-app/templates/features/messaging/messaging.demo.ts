import { Logger } from '@dunx/core';
import { AmqpConnection, AmqpPublisher } from '@dunx/infra/amqp';
import {
  ORDERS_EXCHANGE,
  OrdersMessages,
  PLACED_KEY,
  SHIPPED_KEY,
} from './orders.messages.js';

/** How long to give the broker to deliver before reporting what arrived. */
const SETTLE_MS = 1_500;

/** RabbitMQ end to end: publish to a topic exchange, let the broker route, read
 * back what the handlers in this container received. Skips with no broker. */
export class MessagingDemo {
  constructor(
    private readonly logger: Logger,
    private readonly publisher: AmqpPublisher,
    private readonly connection: AmqpConnection,
    private readonly messages: OrdersMessages,
  ) {}

  async demonstrate(): Promise<void> {
    if (!this.connection.ready) {
      this.logger.info(
        'no AMQP broker reachable - skipping the message broker section',
      );
      return;
    }

    const id = Bun.randomUUIDv7().slice(0, 8);
    for (const routingKey of [PLACED_KEY, SHIPPED_KEY]) {
      await this.publisher.publish(
        { exchange: ORDERS_EXCHANGE, routingKey, messageId: id },
        { id, total: 42 },
      );
    }
    this.logger.info(
      `published ${id} to ${ORDERS_EXCHANGE} twice - the broker routes each ` +
        'key to its own queue, and this container consumes both',
    );

    await this.settle();
    const mine = this.messages.handled.filter((entry) => entry.id === id);
    this.logger.info(
      `${mine.length} of 2 delivered to ${mine.map((entry) => entry.queue).join(', ')}`,
    );
    // The whole reason `publish` exists rather than `publisher().send()`: the
    // handler ran inside the trace the publishing request was in.
    this.logger.info(
      `the handlers ran under traceId ${mine[0]?.traceId ?? '(none)'}, which is ` +
        'the traceId of this line - a trace that crossed the broker',
    );
  }

  private async settle(): Promise<void> {
    const deadline = Date.now() + SETTLE_MS;
    while (Date.now() < deadline && this.messages.handled.length < 2) {
      await Bun.sleep(50);
    }
  }
}
