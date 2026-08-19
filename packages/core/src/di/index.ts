export {
  AppFactory,
  AppRef,
  type App,
  type AppOptions,
  type ShutdownSignal,
} from './app.js';
export { CircularDependencyError, AppError } from './errors.js';
// The dependency record's reader, not just its key. `Symbol.for('dunx.deps')` is
// the cross-copy contract, but a package that reads the symbol itself also has to
// restate the prototype-chain lookup, the lazy thunk call, and the shape of an
// `unresolved` entry - and would silently drop a field this ever gains.
// `@dunx/mcp` is what made that concrete: it reports the container graph, so it
// needs exactly what the container reads.
export {
  isUnresolved,
  readDeps,
  type DepEntry,
  type UnresolvedDep,
} from './deps.js';
export { inject } from './inject.js';
// The prototype-chain walk behind every discovery-by-marker feature. Core owns the
// marker technique, so it owns reading it back: `@dunx/http` had written this walk
// twice, for routes and for gateway handlers, and `@dunx/infra` a third time for
// `@JobHandler`. Three copies meant a fix to the dedup or the `Object.prototype`
// stop landing in one of them.
export { classOf, markedMethods, type MarkedMethod } from './marked.js';
export type { OnBeforeShutdown, OnInit, OnShutdown } from './lifecycle.js';
// The hook installer itself, not just its options: @dunx/http and @dunx/infra each
// own an application class with its own `enableShutdownHooks`, and three copies of
// "drain, then make sure the process actually ends" is three chances to fix the
// hang in one of them and not the others - which is how it got missed the first time.
export { ShutdownHooks, type ShutdownHookOptions } from './shutdown-hooks.js';
// collectModules + readControllers are the adapter seam: an HTTP package needs to
// walk the import graph and find which instances to scan. Injector, readModule and
// the lifecycle type guards stay internal - nothing outside core consumes them, and
// exporting Injector would freeze the container's shape as public API.
//
// `isModuleRef` and `findRootModule` are here because `@Module`'s marker is here.
// Every tool that takes an entry path has to find the root module among a file's
// exports, and a second implementation of that is a second set of conventions:
// requiring `default`/`root` is what made both CLIs fail on a scaffolded app.
// The graph readers. Here rather than in `@dunx/mcp`, which is where they were
// written, because a second consumer exists: `@dunx/dashboard` reports the same
// container from inside a running app, and a dashboard peer-depending on an MCP
// server to borrow a traversal is upside down. `@dunx/mcp` re-exports them.
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
} from './graph.js';
export {
  collectModules,
  findRootModule,
  isModuleRef,
  Module,
  readControllers,
  ROOT_MODULE,
  type DynamicModule,
  type ModuleClass,
  type ModuleOptions,
  type ModuleRef,
  type ProviderEntry,
  type ResolvedModule,
  type RootModuleResult,
} from './module.js';
// The scope graph, exported because anything that reports on the container needs it:
// `@dunx/http` maps a controller to its module's middleware, and `@dunx/mcp` reports
// which module declares a provider and whether it is exported.
export {
  buildScopes,
  unresolvableMessage,
  type Binding,
  type Scope,
  type ScopeGraph,
} from './scope.js';
export {
  provide,
  type AsyncModuleConfig,
  type ClassProvider,
  type Deps,
  type FactoryProvider,
  type Registration,
  type Resolved,
  type ValueProvider,
} from './provider.js';
// `describeToken` is how a token is named in an error, and anything reporting on
// the container needs the same answer: a class token is its name, a `token()` is
// its description. Restating it gets `[object Object]` for the second case.
export {
  describeToken,
  token,
  type AbstractCtor,
  type Ctor,
  type InjectionToken,
  type Token,
} from './token.js';
