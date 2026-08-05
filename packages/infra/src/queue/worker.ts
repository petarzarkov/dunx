import {
  AppFactory,
  collectModules,
  Logger,
  type App,
  type InjectionToken,
  type ModuleRef,
  type ResolvedModule,
  type ShutdownSignal,
} from '@dunx/core';
import { Worker, type Job } from 'bullmq';
import { QueueConnection } from './connection.js';
import { JobDispatcher } from './dispatcher.js';
import { describeJob, discoverJobs, type DiscoveredJob } from './discover.js';
import { QueueError, QueueErrorCode } from './errors.js';
import { QueueOptions } from './options.js';

export interface WorkerAppOptions {
  /**
   * Consume only these queues. Defaults to every queue a handler was found for,
   * which is what a single worker process wants; naming a subset is how one queue
   * gets its own process and its own concurrency.
   */
  readonly queues?: readonly string[];
}

/**
 * What a worker process holds. `create` discovers and validates; `start` is what
 * opens the connections - so a wiring mistake fails before anything consumes.
 */
export interface WorkerApp extends App {
  /** Every handler discovered, after the `queues` filter. */
  readonly jobs: readonly DiscoveredJob[];
  /** The queues this process will consume, in discovery order. */
  readonly queues: readonly string[];
  /** Opens one bullmq `Worker` per queue and waits for each to be ready. */
  start(): Promise<readonly string[]>;
}

/**
 * The consuming half, with no `App` of its own. `WorkerFactory.create` owns a
 * container and delegates here; `WorkerFactory.attach` hands this to a process
 * that already has one, so a single process can serve HTTP and consume jobs.
 */
export class QueueConsumer {
  readonly jobs: readonly DiscoveredJob[];
  readonly queues: readonly string[];
  readonly #dispatcher: JobDispatcher;
  readonly #connection: QueueConnection;
  readonly #options: QueueOptions;
  readonly #logger: Logger;
  readonly #workers: Worker[] = [];
  #started = false;
  #stopping: Promise<void> | undefined;

  constructor(
    app: App,
    dispatcher: JobDispatcher,
    jobs: readonly DiscoveredJob[],
    queues: readonly string[],
  ) {
    this.#dispatcher = dispatcher;
    this.jobs = jobs;
    this.queues = queues;
    this.#connection = app.get(QueueConnection);
    this.#options = app.get(QueueOptions);
    this.#logger = app.get(Logger);
  }

  async start(): Promise<readonly string[]> {
    if (this.#started) {
      throw new QueueError(
        QueueErrorCode.INVALID_STATE,
        'start() has already run. One worker per queue per process.',
      );
    }
    this.#started = true;

    for (const queue of this.queues) {
      this.#workers.push(this.#open(queue));
    }
    // Serially rather than Promise.all, so an unreachable server is reported
    // against the first queue instead of once per queue.
    for (const worker of this.#workers) await worker.waitUntilReady();

    this.#logger.info(
      `Consuming ${this.jobs.length} job(s) on ${this.queues.length} queue(s)`,
      {
        url: this.#options.redactedUrl,
        queues: this.queues,
        jobs: this.jobs.map((job) => `${job.queue}/${job.name}`),
      },
    );
    return this.queues;
  }

  /**
   * Stops consuming and waits for whatever is mid-flight. Idempotent.
   *
   * This has to happen **before** the providers tear down, or a handler still
   * running would find its database connection closed underneath it. `close()`
   * without `force` is what makes that safe: bullmq stops fetching and waits for
   * what is already running.
   */
  async stop(): Promise<void> {
    this.#stopping ??= (async () => {
      await Promise.all(this.#workers.map((worker) => worker.close()));
      this.#workers.length = 0;
    })();
    return this.#stopping;
  }

  #open(queue: string): Worker {
    const worker = new Worker(
      queue,
      (job: Job) => this.#dispatcher.dispatch(job),
      {
        ...this.#options.worker,
        connection: this.#connection.client(),
        prefix: this.#options.prefix,
      },
    );

    worker.on('completed', (job) =>
      this.#logger.debug(`Job completed ${describeJob(job)}`),
    );
    worker.on('failed', (job, error) => {
      // A job can fail before bullmq has one to report - a lock lost to a stall
      // check, say - and the queue is still worth naming.
      const subject = job ? describeJob(job) : `a job on ${queue}`;
      this.#logger.error(`Job failed ${subject}`, error);
    });
    worker.on('error', (error) =>
      this.#logger.error(`Worker error on ${queue}`, error),
    );
    return worker;
  }
}

/**
 * The handlers this worker will run, or a boot error explaining why there are
 * none. Shared by `create` and `attach`; only `create` owns a container to tear
 * down when it throws.
 */
const selectJobs = (
  modules: readonly ResolvedModule[],
  resolve: (token: InjectionToken<unknown>) => unknown,
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

/** A worker process: a {@link QueueConsumer} plus the container it owns. */
class WorkerApplication implements WorkerApp {
  readonly closed: Promise<void>;
  /** Forwarded from the container, so a worker reports scope warnings too. */
  readonly warnings: readonly string[];
  readonly #app: App;
  readonly #consumer: QueueConsumer;
  #resolveClosed: (() => void) | undefined;
  #shuttingDown: Promise<void> | undefined;
  #hooked = false;

  constructor(app: App, consumer: QueueConsumer) {
    this.warnings = app.warnings;
    this.#app = app;
    this.#consumer = consumer;
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
  }

  get jobs(): readonly DiscoveredJob[] {
    return this.#consumer.jobs;
  }

  get queues(): readonly string[] {
    return this.#consumer.queues;
  }

  get<T>(token: InjectionToken<T>): T {
    return this.#app.get(token);
  }

  start(): Promise<readonly string[]> {
    return this.#consumer.start();
  }

  /** Consumers first, then providers. The order is the whole point. */
  async shutdown(): Promise<void> {
    this.#shuttingDown ??= (async () => {
      await this.#consumer.stop();
      await this.#app.shutdown();
      this.#resolveClosed?.();
    })();
    return this.#shuttingDown;
  }

  enableShutdownHooks(
    signals: readonly ShutdownSignal[] = ['SIGTERM', 'SIGINT'],
  ): this {
    if (this.#hooked) return this;
    this.#hooked = true;
    for (const signal of signals) {
      process.once(signal, () => void this.shutdown());
    }
    return this;
  }
}

/**
 * Read off the module graph rather than by resolving the token, because
 * `QueueOptions` is a class whose constructor argument is optional - so an unbound
 * container would **self-bind** it and hand back defaults instead of failing. A
 * worker silently pointed at `localhost` is worse than one that will not boot.
 */
const assertQueueModule = (modules: readonly ResolvedModule[]): void => {
  const bound = modules.some((module) =>
    (module.options.providers ?? []).some(
      (entry) => typeof entry !== 'function' && entry.token === QueueOptions,
    ),
  );
  if (bound) return;

  throw new QueueError(
    QueueErrorCode.INVALID_STATE,
    'A worker needs the queue bindings, and this module graph has none. Import ' +
      'QueueModule.forRoot() (or forRootAsync) from the root module the worker ' +
      'boots.',
  );
};

/**
 * The entrypoint of a worker process.
 *
 * It boots the same container an HTTP process would - the root module it is given
 * may be the app's own, or a narrower one that leaves the controllers out - then
 * finds the handlers by inspection and consumes for them:
 *
 * ```ts
 * const worker = await WorkerFactory.create(WorkerModule);
 * await worker.start();
 * worker.enableShutdownHooks();
 * await worker.closed;
 * ```
 */
export class WorkerFactory {
  static async create(
    root: ModuleRef,
    options: WorkerAppOptions = {},
  ): Promise<WorkerApp> {
    // Before the container is built: nothing is gained by booting an app that
    // cannot possibly consume.
    const modules = collectModules(root);
    assertQueueModule(modules);

    const app = await AppFactory.create(root);
    const queueOptions = app.get(QueueOptions);

    let jobs: readonly DiscoveredJob[];
    try {
      jobs = selectJobs(modules, (token) => app.get(token), options.queues);
    } catch (error) {
      // This path owns the container, so a rejected wiring has to take it down.
      await app.shutdown();
      throw error;
    }

    const dispatcher = new JobDispatcher(jobs, queueOptions.jobTimeoutMs);
    const consumer = new QueueConsumer(
      app,
      dispatcher,
      jobs,
      dispatcher.queues,
    );
    return new WorkerApplication(app, consumer);
  }

  /**
   * Consume inside a container that already exists, so one process can serve HTTP
   * **and** work the queues:
   *
   * ```ts
   * const app = await HttpFactory.create(AppModule);
   * const consumer = await WorkerFactory.attach(app, AppModule);
   * await app.listen(3000);
   * await consumer.start();
   * ```
   *
   * `root` is the same module ref the app was built from; the handlers are found
   * by inspecting it, and resolved out of the container that is already running.
   *
   * **Stop the consumer before shutting the app down.** Nothing here can enforce
   * it, because `App` has no hook to register against, and a worker still running
   * when providers tear down finds its database connection closed underneath it:
   *
   * ```ts
   * await consumer.stop();
   * await app.shutdown();
   * ```
   */
  static async attach(
    app: App,
    root: ModuleRef,
    options: WorkerAppOptions = {},
  ): Promise<QueueConsumer> {
    const modules = collectModules(root);
    assertQueueModule(modules);

    const jobs = selectJobs(modules, (token) => app.get(token), options.queues);
    const dispatcher = new JobDispatcher(
      jobs,
      app.get(QueueOptions).jobTimeoutMs,
    );
    return new QueueConsumer(app, dispatcher, jobs, dispatcher.queues);
  }
}
