import { Logger } from '@dunx/core';
import { AmqpConnection, AmqpPublisher } from '@dunx/infra/amqp';
import {
  ORDERS_EXCHANGE,
  OrdersMessages,
  PLACED_KEY,
  SHIPPED_KEY,
  type Handled,
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

    const mine = await this.settle(id);
    // Sorted, so the line is the same on every run: the two queues have a
    // consumer each on its own channel, and either can finish first.
    const queues = mine.map((entry) => entry.queue).sort();
    this.logger.info(`${mine.length} of 2 delivered to ${queues.join(', ')}`);
    // The whole reason `publish` exists rather than `publisher().send()`: the
    // handler ran inside the trace the publishing request was in.
    this.logger.info(
      `the handlers ran under traceId ${mine[0]?.traceId ?? '(none)'}, which is ` +
        'the traceId of this line - a trace that crossed the broker',
    );
  }

  /** Waits for **this** publish, not for a total: `handled` keeps every delivery
   * the process has seen, so a count crosses two the moment anything else runs. */
  private async settle(id: string): Promise<readonly Handled[]> {
    const deadline = Date.now() + SETTLE_MS;
    let mine = this.messages.handled.filter((entry) => entry.id === id);
    while (Date.now() < deadline && mine.length < 2) {
      await Bun.sleep(50);
      mine = this.messages.handled.filter((entry) => entry.id === id);
    }
    return mine;
  }
}
