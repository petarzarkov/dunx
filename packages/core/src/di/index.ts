export { AppFactory, type App, type ShutdownSignal } from './app.js';
export { CircularDependencyError, AppError } from './errors.js';
export { inject } from './inject.js';
export type { OnInit, OnShutdown } from './lifecycle.js';
// collectModules + readControllers are the adapter seam: an HTTP package needs to
// walk the import graph and find which instances to scan. Injector, readModule and
// the lifecycle type guards stay internal — nothing outside core consumes them, and
// exporting Injector would freeze the container's shape as public API.
export {
  collectModules,
  Module,
  readControllers,
  type DynamicModule,
  type ModuleClass,
  type ModuleOptions,
  type ModuleRef,
  type ProviderEntry,
  type ResolvedModule,
} from './module.js';
export {
  provide,
  type ClassProvider,
  type Deps,
  type FactoryProvider,
  type Registration,
  type Resolved,
  type ValueProvider,
} from './provider.js';
export {
  token,
  type AbstractCtor,
  type Ctor,
  type InjectionToken,
  type Token,
} from './token.js';
