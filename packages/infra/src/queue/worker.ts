import {
  AppFactory,
  collectModules,
  Logger,
  ShutdownAware,
  teardownError,
  teardownFailures,
  type App,
  type InjectionToken,
  type ModuleRef,
  type ResolvedModule,
} from '@dunx/core';
import { Worker, type Job } from 'bullmq';
import { QueueConnection } from './connection.js';
import { JobDispatcher } from './dispatcher.js';
import { describeJob, selectJobs, type DiscoveredJob } from './discover.js';
import { QueueError, QueueErrorCode } from './errors.js';
import { QueueOptions } from './options.js';

export interface WorkerAppOptions {
  /** Consume only these queues. Defaults to every queue a handler was found for;
   * naming a subset gives one queue its own process and concurrency. */
  readonly queues?: readonly string[];
  /**
   * Run a queue's jobs in a child rather than inline. No option here: a queue is
   * sandboxed by `@JobHandler({ background: true })`, and the file to fork into
   * is `QueueModule.forRoot({ processor })`. Both live with the jobs.
   */
}

/**
 * `FORCE_COLOR` for a forked child. bullmq forks with `stdio: 'pipe'`, so every
 * colour check inside the child answers for that pipe rather than the terminal
 * the lines end up on, and a worker's output came out uncoloured. Absent when
 * either variable is already set: that is the consumer's answer, not a guess.
 */
export const childColourEnv = (
  env: Record<string, string | undefined>,
  colours: boolean,
): Record<string, string | undefined> | undefined => {
  if (!colours) return undefined;
  if ('NO_COLOR' in env || env['FORCE_COLOR'] !== undefined) return undefined;
  return { ...env, FORCE_COLOR: '1' };
};

/** The half of a bullmq `Worker` {@link closeWithin} needs. */
interface Closable {
  close(force?: boolean): Promise<void>;
}

/**
 * How long a worker that reached readiness gets to finish what it is holding
 * before `start()` stops waiting for it. Workers drain concurrently, so this
 * bounds the whole teardown rather than each one.
 */
const DRAIN_ON_FAILED_START_MS = 5_000;

/**
 * A graceful close, waited on for at most `ms`.
 *
 * **The close cannot be escalated**, so this stops waiting rather than forcing.
 * bullmq 6.0.5's `Worker.close` returns the `closing` promise it already started
 * (`worker.js:736`), so a later `close(true)` is the same pending promise and
 * forces nothing. A first call decides which kind of close a worker gets, and
 * that is the only decision available.
 *
 * Which is why the choice is made per worker before either is called: a worker
 * that never became ready is force-closed outright, and only one that may be
 * holding a job is drained through here.
 *
 * The timer is unref'd, so a worker that closes in time cannot leave it holding
 * the process open.
 */
export const closeWithin = async (
  worker: Closable,
  ms: number,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gaveUp = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([worker.close(), gaveUp]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
};

/** How often one queue's worker may report a connection error. */
const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * Answers whether this error is the one to report, at most once per interval.
 *
 * Time rather than a `ready` gate: bullmq emits `Worker`'s `ready` once, from the
 * initial `waitUntilReady` chain (`worker.js:125`), and the connection's recurring
 * ready reaches the backend rather than the worker. A gate cleared on that event
 * would latch after the first outage and silence every one after it.
 */
export const errorThrottle = (
  intervalMs: number,
  now: () => number = Date.now,
): (() => boolean) => {
  let last = Number.NEGATIVE_INFINITY;
  return () => {
    const at = now();
    if (at - last < intervalMs) return false;
    last = at;
    return true;
  };
};

/** What a worker process holds. `create` discovers and validates; `start` opens
 * the connections, so a wiring mistake fails before anything consumes. */
export interface WorkerApp extends App {
  /** Every handler discovered, after the `queues` filter. */
  readonly jobs: readonly DiscoveredJob[];
  /** The queues this process will consume, in discovery order. */
  readonly queues: readonly string[];
  /** Opens one bullmq `Worker` per queue and waits for each to be ready. */
  start(): Promise<readonly string[]>;
}

/**
 * The consuming half, with no `App` of its own. `create` owns a container and
 * delegates here; `attach` hands this to a process that already has one.
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

  /** A queue is sandboxed when any handler on it is marked `background`: bullmq
   * opens one `Worker` per queue, given either a path or a function. */
  #isBackground(queue: string): boolean {
    return this.jobs.some((job) => job.queue === queue && job.background);
  }

  async start(): Promise<readonly string[]> {
    if (this.#started) {
      throw new QueueError(
        QueueErrorCode.INVALID_STATE,
        'start() has already run. One worker per queue per process.',
      );
    }
    this.#started = true;

    // Checked before anything opens, so a queue asking for a sandbox that was
    // never configured is a boot error rather than a quiet demotion.
    const unbacked = this.queues.filter(
      (queue) => this.#isBackground(queue) && this.#processor() === undefined,
    );
    if (unbacked.length > 0) {
      throw new QueueError(
        QueueErrorCode.INVALID_STATE,
        `${unbacked.join(', ')} has a @JobHandler({ background: true }) but no ` +
          'processor file is configured. Pass QueueModule.forRoot({ processor }) ' +
          'pointing at the file bullmq should fork into - see JobProcessor.',
      );
    }

    // Which workers reached readiness, so the failure path can tell a worker that
    // may be holding a job from one that never started.
    const ready = new Set<Worker>();
    try {
      // Opened **and** awaited one at a time. Opening them all first left every
      // queue after the first storming while the first was still failing to
      // become ready, so the guard below could not run until the flood had
      // already starved the loop. One queue hid that; two did not.
      for (const queue of this.queues) {
        const worker = this.#open(queue);
        this.#workers.push(worker);
        await worker.waitUntilReady();
        ready.add(worker);
      }
    } catch (error) {
      /**
       * A worker that never became ready is still a running worker. `new Worker()`
       * reconnects immediately, so after `waitUntilReady()` rejects every retry
       * emits `error`: 2.3 million events in 25 s against a dead broker, which
       * starves the event loop and keeps the process alive. Those are force-closed:
       * nothing reached them, so there is nothing to drain.
       *
       * A worker that **did** become ready is a different case, and the old
       * comment here was wrong to lump them together. bullmq starts consuming at
       * readiness, so it may be holding a job, and `close(true)` abandons it for
       * stalled recovery to retry later - running a handler's side effects twice.
       * It gets a bounded drain instead.
       */
      await Promise.allSettled(
        this.#workers.map((worker) =>
          ready.has(worker)
            ? closeWithin(worker, DRAIN_ON_FAILED_START_MS)
            : worker.close(true),
        ),
      );
      this.#workers.length = 0;
      throw error;
    }

    // One entry per queue, naming where its handlers run: a count alone cannot
    // say whether a queue is isolated from the server.
    for (const queue of this.queues) {
      const handlers = this.jobs.filter((job) => job.queue === queue);
      const where = this.#isBackground(queue) ? 'background' : 'foreground';
      this.#logger.info(`Started [${where}] worker for queue: ${queue}`, {
        queue,
        url: this.#options.redactedUrl,
        handlers: handlers
          .map((job) => `${job.name}: ${job.provider}.${job.method}`)
          .join(', '),
        worker: {
          isolation: where === 'foreground' ? 'inline' : this.#isolation(),
          ...(this.#options.worker.concurrency === undefined
            ? {}
            : { concurrency: this.#options.worker.concurrency }),
        },
      });
    }
    return this.queues;
  }

  /**
   * Stops consuming and waits for whatever is mid-flight. Idempotent. Has to run
   * before the providers tear down, or a handler still going would find its
   * database connection closed underneath it.
   */
  async stop(): Promise<void> {
    this.#stopping ??= (async () => {
      await Promise.all(this.#workers.map((worker) => worker.close()));
      this.#workers.length = 0;
    })();
    return this.#stopping;
  }

  /**
   * A file path where a sandbox is configured, a function otherwise. bullmq
   * imports the file in the child and calls its default export; nothing of `this`
   * crosses over, so the child builds its own container. See `JobProcessor`.
   */
  #processor(): string | undefined {
    return this.#options.processor;
  }

  #isolation(): 'process' | 'thread' {
    return this.#options.isolation;
  }

  #open(queue: string): Worker {
    const background = this.#isBackground(queue);
    const processor = this.#processor();
    const forked = background && this.#isolation() === 'process';
    // Nothing added when the consumer passed their own fork options: merging
    // into their `env` would be a guess.
    const env =
      forked && this.#options.worker.workerForkOptions === undefined
        ? childColourEnv(process.env, Bun.enableANSIColors)
        : undefined;
    const worker = new Worker(
      queue,
      background && processor !== undefined
        ? processor
        : (job: Job) => this.#dispatcher.dispatch(job),
      {
        ...this.#options.worker,
        ...(background ? { useWorkerThreads: !forked } : {}),
        ...(env === undefined ? {} : { workerForkOptions: { env } }),
        connection: this.#connection.client(),
        prefix: this.#options.prefix,
      },
    );

    worker.on('completed', (job) =>
      this.#logger.debug(`Job completed ${describeJob(job)}`),
    );
    worker.on('failed', (job, error) => {
      // A job can fail before bullmq has one to report, and the queue is still
      // worth naming.
      const subject = job ? describeJob(job) : `a job on ${queue}`;
      this.#logger.error(`Job failed ${subject}`, error);
    });
    // Throttled, not deduplicated. bullmq reopens a blocking read the moment its
    // connection closes, so against an absent broker this fires in a hot loop:
    // measured at 21.9M lines in two minutes, which is enough I/O to stop a
    // process making progress at all. A later outage still gets reported.
    const report = errorThrottle(ERROR_LOG_INTERVAL_MS);
    worker.on('error', (error) => {
      if (report()) this.#logger.error(`Worker error on ${queue}`, error);
    });
    return worker;
  }
}

/** A worker process: a {@link QueueConsumer} plus the container it owns. */
class WorkerApplication extends ShutdownAware implements WorkerApp {
  readonly closed: Promise<void>;
  /** Forwarded from the container, so a worker reports scope warnings too. */
  readonly warnings: readonly string[];
  readonly #app: App;
  readonly #consumer: QueueConsumer;
  #resolveClosed: (() => void) | undefined;
  #shuttingDown: Promise<void> | undefined;

  constructor(app: App, consumer: QueueConsumer) {
    super();
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
  /** The container's drain phase, delegated. `shutdown()` below stops the
   * consumer before tearing providers down. */
  drain(): Promise<void> {
    return this.#app.drain();
  }

  /**
   * Consumers first, then providers, and every step runs. A worker that could not
   * stop its consumer used to skip the container teardown and leave `closed`
   * pending. Failures are collected and thrown at the end.
   */
  async shutdown(): Promise<void> {
    this.#shuttingDown ??= (async () => {
      const failures: unknown[] = [];
      try {
        await this.#consumer.stop();
      } catch (error) {
        this.#app
          .get(Logger)
          .error('The queue consumer could not be stopped', error);
        failures.push(error);
      }
      try {
        await this.#app.shutdown();
      } catch (error) {
        failures.push(...teardownFailures(error));
      } finally {
        this.#resolveClosed?.();
      }
      if (failures.length > 0) throw teardownError(failures);
    })();
    return this.#shuttingDown;
  }
}

/**
 * Read off the module graph rather than by resolving the token: `QueueOptions`
 * has an optional constructor argument, so an unbound container would self-bind
 * it and hand back defaults. A worker silently pointed at `localhost` is worse
 * than one that will not boot.
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
 * The entrypoint of a worker process. Boots the same container an HTTP process
 * would, then finds the handlers by inspection and consumes for them:
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
    const modules = collectModules(root);
    assertQueueModule(modules);

    const app = await AppFactory.create(root);
    const queueOptions = app.get(QueueOptions);

    let jobs: readonly DiscoveredJob[];
    try {
      jobs = selectJobs(modules, (token) => app.get(token), options.queues);
    } catch (error) {
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
   * Stop the consumer before shutting the app down - `await consumer.stop()`
   * then `await app.shutdown()`. Nothing here can enforce it, and a worker still
   * running when providers tear down loses its database connection.
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
