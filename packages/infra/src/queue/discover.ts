import {
  discoverMarked,
  markedMethods,
  markedMethodsOn,
  type Ctor,
  type DiscoveredMethod,
  type InjectionToken,
  type MarkedMethod,
  type ModuleRef,
  type ResolvedModule,
} from '@dunx/core';
import type { Job } from 'bullmq';
import { QueueError, QueueErrorCode } from './errors.js';
import { jobMetaOf, type JobMeta } from './marker.js';

export type JobHandlerFn = (job: Job) => unknown;

export interface DiscoveredJob extends JobMeta {
  /** The declaring class, for error messages and boot logs. */
  readonly provider: string;
  readonly method: string;
  /** Already bound to its instance. */
  readonly handler: JobHandlerFn;
}

/** Every marked method on a prototype chain, most-derived first, names deduped. */
const eachJobHandler = (
  start: object | null,
): readonly MarkedMethod<JobMeta>[] => markedMethods(start, jobMetaOf);

const asJob = ({
  meta,
  ...found
}: DiscoveredMethod<JobMeta, JobHandlerFn>): DiscoveredJob => ({
  // Spread, not a field list. `DiscoveredJob extends JobMeta`, so picking
  // `queue` and `name` by hand silently dropped `background` the moment the
  // marker grew it - and a queue that asked for a child quietly ran inline.
  ...meta,
  ...found,
});

/**
 * Walks the prototype chain of a constructed provider and collects every marked
 * method. Most-derived wins on a repeated name; an undecorated override does not
 * shadow its decorated base, and dispatch still lands on the override because the
 * handler is bound off the instance.
 */
export const discoverJobsOn = (instance: object): readonly DiscoveredJob[] =>
  markedMethodsOn<JobMeta, JobHandlerFn>(instance, jobMetaOf).map(asJob);

/** Whether a class declares a handler, without constructing it. */
export const declaresJobHandler = (ctor: Ctor<unknown>): boolean =>
  eachJobHandler(ctor.prototype as object | null).length > 0;

/**
 * Two handlers for one `(queue, name)` pair would silently split the traffic
 * between them, so it is a boot error naming both.
 */
export const assertNoDuplicateJobs = (
  jobs: readonly DiscoveredJob[],
): readonly DiscoveredJob[] => {
  const claimed = new Map<string, DiscoveredJob>();

  for (const job of jobs) {
    // JSON rather than a joined pair: `queue` and `name` are unvalidated
    // strings, so any single separator makes ("a", "b<sep>c") and ("a<sep>b",
    // "c") one key and one of the two a phantom duplicate at boot.
    const key = JSON.stringify([job.queue, job.name]);
    const existing = claimed.get(key);
    if (existing) {
      throw new QueueError(
        QueueErrorCode.DUPLICATE_HANDLER,
        `Two handlers claim job "${job.name}" on queue "${job.queue}": ` +
          `${existing.provider}.${existing.method}() and ` +
          `${job.provider}.${job.method}(). One job name, one handler.`,
      );
    }
    claimed.set(key, job);
  }

  return jobs;
};

/**
 * Handlers are declared in `@Module({ providers })` - or on a controller - like
 * any other injectable, and found here by their marker. That is the same
 * discovery-by-inspection routes and gateways get, with no registry to keep in
 * step and no global array to leak across files.
 *
 * A factory- or value-provided instance is not scanned: there is no class to read
 * a prototype chain from until it has been built, and building it to find out
 * whether it is worth building is the ordering trap the marker technique exists to
 * avoid. Put handlers on a class provider.
 */
export const discoverJobs = (
  modules: readonly ResolvedModule[],
  resolve: (token: InjectionToken<unknown>, from: ModuleRef) => unknown,
): readonly DiscoveredJob[] => {
  const discovered = discoverMarked<JobMeta, JobHandlerFn>(
    modules,
    resolve,
    jobMetaOf,
  ).map(asJob);

  return assertNoDuplicateJobs(discovered);
};

/** `<id> <queue>[<name>]` - the identity every queue log line carries. */
export const describeJob = (job: {
  readonly id?: string | undefined;
  readonly queueName: string;
  readonly name: string;
}): string => `${job.id ?? '?'} ${job.queueName}[${job.name}]`;

/**
 * The handlers a worker will run, or a boot error explaining why there are none.
 *
 * Shared by `WorkerFactory.create`, `WorkerFactory.attach` and `JobProcessor`, so
 * a parent and the child it forks fail the same way on the same wiring - a child
 * that discovered a different set would be a mismatch nobody sees until a job
 * arrives.
 */
export const selectJobs = (
  modules: readonly ResolvedModule[],
  resolve: (token: InjectionToken<unknown>, from: ModuleRef) => unknown,
  wanted: readonly string[] | undefined,
): readonly DiscoveredJob[] => {
  const discovered = discoverJobs(modules, resolve);
  const jobs = wanted
    ? discovered.filter((job) => wanted.includes(job.queue))
    : discovered;

  if (jobs.length === 0) {
    throw new QueueError(
      QueueErrorCode.NO_HANDLERS,
      wanted
        ? `No handler consumes ${wanted.join(', ')}. A worker with nothing to ` +
            'do would idle forever, so this is a boot error.'
        : 'No job handlers were found. Decorate a method with @JobHandler and ' +
            'declare its class in a module this root imports.',
    );
  }

  // A typo in one name of several would otherwise start a process that quietly
  // serves only the queues that were spelled right.
  const missing = (wanted ?? []).filter(
    (queue) => !jobs.some((job) => job.queue === queue),
  );
  if (missing.length > 0) {
    throw new QueueError(
      QueueErrorCode.NO_HANDLERS,
      `No handler consumes ${missing.join(', ')}. Found handlers for ` +
        `${[...new Set(discovered.map((job) => job.queue))].join(', ')}.`,
    );
  }

  return jobs;
};
