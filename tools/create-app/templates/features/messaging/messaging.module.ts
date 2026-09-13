import { Module } from '@dunx/core';
import { AmqpConnection, AmqpPublisher, AmqpModule } from '@dunx/infra/amqp';
import { AppConfigService } from '../config.js';
import { MessagingController } from './messaging.controller.js';
import { MessagingDemo } from './messaging.demo.js';
import { ORDERS_EXCHANGE, OrdersMessages } from './orders.messages.js';

/**
 * The same module a web process and a dedicated consumer would both import.
 * `consume: true` makes this container do both; leave it out and it binds the
 * publish side alone.
 */
@Module({
  imports: [
    AmqpModule.forRootAsync({
      useFactory: (config: AppConfigService) => {
        const { url } = config.get('amqp');
        return {
          ...(url === undefined ? {} : { url }),
          connectionName: 'dunx-full',
          consume: true,
          // The exchange this app owns, declared once and re-declared on every
          // reconnect rather than on every publish.
          publisher: {
            confirm: true,
            exchanges: [
              { exchange: ORDERS_EXCHANGE, type: 'topic', durable: true },
            ],
          },
          // Short, so `bun run tour` against an absent broker says so and moves
          // on instead of holding boot for five seconds.
          readyTimeoutMs: 1_500,
          // Well under the package's 10 s default, because a request is waiting
          // on this one: the landing page's broker panel wants the 503 while the
          // visitor is still looking at it.
          publishTimeoutMs: 2_000,
          drainTimeoutMs: 2_000,
          handlerTimeoutMs: 10_000,
        };
      },
      inject: [AppConfigService] as const,
    }),
  ],
  controllers: [MessagingController],
  providers: [OrdersMessages, MessagingDemo],
  exports: [AmqpConnection, AmqpPublisher, OrdersMessages, MessagingDemo],
})
export class MessagingModule {}
