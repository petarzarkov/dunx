import type { ConsumerPassthrough } from './options.js';

// Symbol.for, so two copies of @dunx/infra in a tree still agree on the key. The
// marker goes on the method function itself - nothing accumulates at class
// definition time, so there is no ordering dependence and no cross-file leak.
// Same technique as job, route and gateway discovery.
const AMQP = Symbol.for('dunx.amqp.handler');

export interface AmqpMeta {
  /** The queue this handler consumes, declared before the first delivery. */
  readonly queue: string;
  /**
   * Declared and bound to {@link queue} before consuming. Absent, the queue is
   * consumed as it is and a publisher addresses it by name.
   */
  readonly exchange?: string;
  /** The binding key. Defaults to {@link queue}. Ignored without an exchange. */
  readonly routingKey?: string;
  /** @default 'topic' */
  readonly exchangeType?: string;
  /**
   * Forwarded verbatim to `createConsumer`, merged over `AmqpOptions.consumer`:
   * `concurrency`, `qos`, `requeue`, `queueOptions`, and further `exchanges` and
   * `queueBindings` where one convenience pair is not enough.
   */
  readonly consumer?: ConsumerPassthrough;
}

interface AmqpMarked {
  readonly [AMQP]?: AmqpMeta;
}

export const markAmqpHandler = (target: object, meta: AmqpMeta): void => {
  Object.defineProperty(target, AMQP, { value: meta, configurable: true });
};

export const amqpMetaOf = (value: unknown): AmqpMeta | undefined =>
  typeof value === 'function' ? (value as AmqpMarked)[AMQP] : undefined;
