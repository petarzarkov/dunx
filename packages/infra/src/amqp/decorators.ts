import type { HandlerMethod } from '@dunx/core';
import { markAmqpHandler, type AmqpMeta } from './marker.js';

/**
 * Marks a method as the consumer of `queue`. There is no class decorator: the
 * marker is the whole record, and discovery walks the prototype chains of the
 * classes the modules already declare.
 *
 * ```ts
 * class OrdersConsumer {
 *   @AmqpHandler({ queue: 'orders.created', exchange: 'orders', routingKey: 'created' })
 *   async onCreated(message: AmqpMessage<OrderCreated>): Promise<void> {
 *     await this.orders.record(message.body);
 *   }
 * }
 * ```
 */
export const AmqpHandler =
  (meta: AmqpMeta) =>
  <T extends HandlerMethod>(value: T): T => {
    markAmqpHandler(value, meta);
    return value;
  };
