export { QueueConnection } from './connection.js';
export { JobHandler } from './decorators.js';
export { JobDispatcher } from './dispatcher.js';
// The two validators `discoverJobs` runs internally are deliberately not here:
// nothing outside a worker runtime calls them, and exporting them would freeze them
// as semver surface.
export {
  describeJob,
  discoverJobs,
  discoverJobsOn,
  selectJobs,
  type DiscoveredJob,
  type JobHandlerFn,
} from './discover.js';
export { QueueError, QueueErrorCode } from './errors.js';
export { type JobMeta } from './marker.js';
export { QueueModule } from './module.js';
export {
  QueueOptions,
  type QueueOptionsInit,
  type WorkerPassthrough,
} from './options.js';
export { JobPublisher } from './publisher.js';
// The child half of a sandboxed worker: `export default new
// JobProcessor(M).handle` is the whole file bullmq forks into.
export { JobProcessor, type JobProcessorOptions } from './processor.js';
// Consuming owned by the container: bound by `QueueModule.forRoot({ consume })`,
// started at onInit and stopped at onShutdown, before the connections close.
export { QueueRunner } from './runner.js';
export {
  QueueConsumer,
  WorkerFactory,
  type WorkerApp,
  type WorkerAppOptions,
} from './worker.js';
