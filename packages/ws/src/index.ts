export {
  Gateway,
  OnClose,
  OnDrain,
  OnMessage,
  OnOpen,
  OnPing,
  OnPong,
  OnUpgrade,
} from './gateway/decorators.js';
export {
  discoverGateway,
  normalizePath,
  type DiscoveredGateway,
  type DiscoveredHandler,
  type Invoke,
} from './gateway/discover.js';
// One name, both meanings — the value for `HandlerKind.MESSAGE`, the type for
// annotations. Exactly what an enum gives, without the enum.
export { HandlerKind, type HandlerMeta } from './gateway/marker.js';
export { WsModule, type WsAsyncOptions } from './module.js';
export {
  buildAdapter,
  createWsAdapter,
  type WsAdapter,
} from './server/adapter.js';
export { decode, encode, type Envelope } from './server/envelope.js';
export { WsFactory, type WsApp } from './server/factory.js';
export {
  WsSettings,
  type SocketOptions,
  type WsOptions,
} from './server/options.js';
export { PubSub } from './server/pubsub.js';
export {
  buildGateways,
  buildRuntime,
  type GatewayRuntime,
} from './server/runtime.js';
export type { ErrorHandler, Socket, SocketData } from './server/socket.js';
