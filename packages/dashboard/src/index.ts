export { DashboardModule } from './module.js';
export { DashboardMiddleware } from './middleware.js';
export {
  DashboardOptions,
  normalizeMount,
  type Authorize,
  type DashboardOptionsInit,
  type Reveal,
} from './options.js';
// The structural restatements. Exported because an app wiring `queues` or `redis`
// may want to name the shape it is satisfying, and because anything else that can
// satisfy one - a fake in a test, a second queue library - needs the contract.
export type {
  ConfigValues,
  DashboardProbe,
  ProbeResult,
  ProbeState,
  QueueSource,
  RedisProbe,
} from './contracts.js';
// The wire format, so a consumer can type a `fetch` of the JSON endpoints - which
// are a supported way to read the dashboard, not an implementation detail of the
// page. `internal/dashboard-ui` imports them from the source for the same reason.
export type {
  ConfigEntry,
  GatewayNode,
  MemoryReport,
  Meta,
  ModuleNode,
  ProbeReport,
  ProviderNode,
  QueuesReport,
  RedisAbsent,
  RedisReport,
  RouteNode,
  RuntimeReport,
  Snapshot,
} from './api/types.js';
// The dispatcher, exported so an app that wants the data behind its own controller
// - or a test - can call it without a server. `renderPage` is deliberately **not**
// here; it lives behind `@dunx/dashboard/ui` so importing this package does not
// load the bundle.
export { handleDashboard, type RouterDeps } from './router.js';
