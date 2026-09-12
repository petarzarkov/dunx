/**
 * `@dunx/http/connect` - protobuf services over Connect and gRPC-Web, mounted as
 * middleware. `@connectrpc/connect` and `@bufbuild/protobuf` are optional peers,
 * and importing `@dunx/http` does not load any of this.
 *
 * Native gRPC is not here: `grpc-status` travels in an HTTP trailer and
 * `Bun.serve` sends none. See `internal/notes/research/rpc.md`.
 */
export { ConnectMiddleware } from './connect/middleware.js';
export { ConnectModule, type ConnectSettings } from './connect/module.js';
export {
  connectService,
  ConnectOptions,
  normalizeConnectPrefix,
  type ConnectOptionsInit,
  type ConnectRouterSettings,
  type ConnectServiceRegistration,
} from './connect/options.js';
export {
  ConnectRegistry,
  type ConnectHandler,
  type ConnectMethodInfo,
} from './connect/registry.js';
