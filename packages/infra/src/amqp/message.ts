import type { AsyncMessage } from 'rabbitmq-client';

/**
 * One delivery, with its body typed. `rabbitmq-client`'s own `AsyncMessage`
 * narrowed on `body` alone, so `routingKey`, `exchange`, `redelivered`,
 * `deliveryTag`, `headers` and `correlationId` stay the library's.
 *
 * The library parses an `application/json` content type into an object and leaves
 * anything else a `Buffer`, so `T` is whatever the publisher sent.
 */
export type AmqpMessage<T = unknown> = Omit<AsyncMessage, 'body'> & {
  readonly body: T;
};

/**
 * `<id> <queue>[<routingKey>]` - the identity every AMQP log line carries. The
 * message id when the publisher set one, the delivery tag otherwise, which
 * identifies a delivery rather than a message.
 */
export const describeMessage = (
  queue: string,
  message: Pick<AsyncMessage, 'messageId' | 'deliveryTag' | 'routingKey'>,
): string =>
  `${message.messageId ?? `#${message.deliveryTag}`} ${queue}[${message.routingKey}]`;
