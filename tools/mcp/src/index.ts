export { handle, serve, PROTOCOL_VERSION, RpcError } from './protocol.js';
export type { JsonRpcRequest, ToolDefinition } from './protocol.js';
export { toolsFor } from './tools.js';
// The readers behind the tools, re-exported so a server of your own can answer
// the same questions without reimplementing the traversal. They **moved down** to
// the packages that own the data they read - the container half to `@dunx/core`,
// the route half to `@dunx/http` - the moment `@dunx/dashboard` became a second
// consumer. Nothing importing them from here breaks.
//
// One difference to know: core's `providersOf`/`modulesOf` take the gateway
// predicate as an option, because core cannot import `@dunx/http`. Pass
// `{ isGateway }` from `@dunx/http`, as `toolsFor` does.
export {
  dependenciesOf,
  modulesOf,
  providersOf,
  type Dependency,
  type GraphOptions,
  type ModuleNode,
  type ProviderKind,
  type ProviderNode,
  type ProviderRole,
} from '@dunx/core';
export {
  gatewaysOf,
  routesOf,
  type GatewayHandler,
  type GatewayNode,
  type RouteInputs,
  type RouteNode,
} from '@dunx/http';
export {
  documentOf,
  OpenApiUnavailableError,
  type OpenApiInput,
} from './openapi.js';
