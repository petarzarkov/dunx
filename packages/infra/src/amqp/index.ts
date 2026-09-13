export { AmqpConnection } from './connection.js';
export { AmqpHandler } from './decorators.js';
export { AmqpDispatcher, type DispatchSettings } from './dispatcher.js';
// `assertNoDuplicateQueues` and `consumerProps` are deliberately not here,
// matching `/queue`: nothing outside this subpath calls them, and exporting one
// would freeze it as semver surface.
export {
  discoverSubscriptions,
  discoverSubscriptionsOn,
  selectSubscriptions,
  type AmqpHandlerFn,
  type DiscoveredSubscription,
} from './discover.js';
export { AmqpError, AmqpErrorCode } from './errors.js';
export { type AmqpMeta } from './marker.js';
export { describeMessage, type AmqpMessage } from './message.js';
export { AmqpModule } from './module.js';
export {
  AMQP_PROTOCOLS,
  AmqpOptions,
  assertAmqpUrl,
  defaultAmqpUrl,
  type AmqpOptionsInit,
  type AmqpProtocol,
  type ConnectionPassthrough,
  type ConsumerPassthrough,
} from './options.js';
export { AmqpPublisher } from './publisher.js';
// Consuming owned by the container: bound by `AmqpModule.forRoot({ consume })`,
// started at onInit and stopped at onShutdown, before the connection closes.
export { AmqpRunner } from './runner.js';
export { AmqpSubscriber } from './subscriber.js';
// `ConsumerStatus` is not re-exported, for the reason `@dunx/infra/queue` does not
// re-export bullmq's `Job`: it is the library's value, the library is an installed
// peer, and a second spelling of it here would be one more name to keep in step.
// A handler that wants to drop or requeue outright imports it from
// `rabbitmq-client`.
