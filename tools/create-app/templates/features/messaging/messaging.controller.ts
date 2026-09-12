import {
  Controller,
  Get,
  HttpError,
  HttpStatusCode,
  Post,
  type Input,
} from '@dunx/http';
import { AmqpConnection, AmqpPublisher } from '@dunx/infra/amqp';
import { z } from 'zod';
import {
  ORDERS_EXCHANGE,
  OrdersMessages,
  PLACED_KEY,
  SHIPPED_KEY,
  type Handled,
} from './orders.messages.js';

const Place = z
  .object({
    id: z.string().min(1).max(64),
    total: z.coerce.number().min(0).default(0),
    shipped: z.boolean().default(false),
  })
  // `.strict()` after `.meta()` discards the metadata; put `.meta()` last.
  .strict()
  .meta({ id: 'PlaceOrder', description: 'An order event to publish' });

const place = { body: Place } as const;

/** The publish side. `AmqpModule.forRoot` binds `AmqpPublisher` and, without
 * `consume`, opens no consumer at all. */
@Controller('messaging')
export class MessagingController {
  constructor(
    private readonly publisher: AmqpPublisher,
    private readonly connection: AmqpConnection,
    private readonly messages: OrdersMessages,
  ) {}

  @Post('/orders', place)
  async place({ body }: Input<typeof place>): Promise<{
    id: string;
    exchange: string;
    routingKey: string;
  }> {
    const routingKey = body.shipped ? SHIPPED_KEY : PLACED_KEY;
    await this.degrades(() =>
      this.publisher.publish(
        { exchange: ORDERS_EXCHANGE, routingKey, messageId: body.id },
        { id: body.id, total: body.total },
      ),
    );
    return { id: body.id, exchange: ORDERS_EXCHANGE, routingKey };
  }

  /**
   * Publishes whatever it is given, so the suite can show a malformed body being
   * dropped rather than redelivered forever. Not a shape any real producer sends.
   */
  @Post('/raw', { body: z.record(z.string(), z.unknown()) })
  async raw({
    body,
  }: Input<{ body: z.ZodType<Record<string, unknown>> }>): Promise<{
    published: boolean;
  }> {
    await this.degrades(() =>
      this.publisher.publish(
        { exchange: ORDERS_EXCHANGE, routingKey: PLACED_KEY },
        body,
      ),
    );
    return { published: true };
  }

  /** What the consumers in this same container received, newest last. */
  @Get('/orders')
  handled(): { connected: boolean; handled: readonly Handled[] } {
    return { connected: this.connection.ready, handled: this.messages.handled };
  }

  /**
   * No broker is a degraded feature, not a broken app. `publish` rejects once
   * the confirm cannot be had, and anything unrecognised still becomes a 503.
   */
  private async degrades<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const { name, message } = error as Error;
      throw new HttpError(
        HttpStatusCode.SERVICE_UNAVAILABLE,
        `Broker unavailable: ${name}: ${message}`,
      );
    }
  }
}
