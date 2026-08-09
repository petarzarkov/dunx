import {
  AppFactory,
  collectModules,
  Logger,
  type App,
  type ModuleRef,
} from '@dunx/core';
import type { Job } from 'bullmq';
import { JobDispatcher } from './dispatcher.js';
import { describeJob, selectJobs } from './discover.js';
import { QueueOptions } from './options.js';

export interface JobProcessorOptions {
  /**
   * Consume only these queues, matching the parent's filter. A child that
   * discovers a handler the parent never opened a `Worker` for simply never
   * receives one, so this is for symmetry and for the message a stray job gets.
   */
  readonly queues?: readonly string[];
  /**
   * Write a start, success and failure line to **the job's own log** with
   * `job.log()`, which lands in Redis and is what bull-board's log tab shows.
   *
   * On by default, because it is the half of the traceability that outlives the
   * process: stdout is gone when the container is recycled, and this is still
   * attached to the job an operator is looking at. It costs one Redis write per
   * line, capped by bullmq's own `keepLogs`.
   *
   * @default true
   */
  readonly trace?: boolean;
  /**
   * Run before the container tears down on `SIGTERM`. bullmq retires a child by
   * signalling it, and anything with cleanup of its own goes here.
   */
  readonly onShutdown?: (app: App) => void | Promise<void>;
}

/**
 * The **child** half of a sandboxed worker.
 *
 * bullmq runs a job outside the main event loop when a `Worker` is given a **file
 * path** instead of a function. That file's default export is the processor, and
 * this is the class that builds one out of a dunx module:
 *
 * ```ts
 * // jobs.processor.ts - the file the child runs
 * import { JobProcessor } from '@dunx/infra/queue';
 * import { JobsModule } from './jobs.module.js';
 *
 * export default new JobProcessor(JobsModule).handle;
 * ```
 *
 * What it buys:
 *
 * - **Traceability.** The child's stdout is the parent's, so a handler's log lines
 *   land in the same stream as the request that enqueued the job - without sharing
 *   an event loop with it. `job.log()` goes further and lands in Redis, where
 *   bull-board shows it against the job itself.
 * - **Isolation.** A handler that blocks, leaks or crashes takes its child down and
 *   not the process serving HTTP.
 *
 * What it costs is a container per child. That is the deal every sandboxed-processor
 * setup makes, and it is why `handle` builds one **once per child and reuses it**
 * rather than once per job: a fork already costs a process, and rebuilding a
 * database pool on top of that would make the sandbox slower than it is worth.
 *
 * Both isolation modes were measured on Bun 1.3.14 and both work - see
 * `SandboxOptions.isolation` for which to pick.
 */
export class JobProcessor {
  readonly #root: ModuleRef;
  readonly #options: JobProcessorOptions;
  #booting: Promise<{ app: App; dispatcher: JobDispatcher }> | undefined;

  constructor(root: ModuleRef, options: JobProcessorOptions = {}) {
    this.#root = root;
    this.#options = options;
  }

  /**
   * An arrow property, not a method, because bullmq imports this file and calls
   * its default export as a bare function - `export default new
   * JobProcessor(M).handle` would lose `this` from a prototype method.
   */
  readonly handle = async (job: Job): Promise<unknown> => {
    this.#booting ??= this.#boot();
    const { app, dispatcher } = await this.#booting;
    const trace = this.#options.trace ?? true;
    const subject = describeJob(job);

    if (trace) await job.log(`started ${subject} in pid ${process.pid}`);
    try {
      const result = await dispatcher.dispatch(job);
      if (trace) await job.log(`completed ${subject}`);
      return result;
    } catch (error) {
      // Both, and they are not redundant. The logger line goes to the stream an
      // operator is tailing; the `job.log` line is attached to the job itself and
      // is still there tomorrow, in bull-board, next to the failure.
      app.get(Logger).error(`Job failed ${subject}`, error);
      if (trace) {
        await job.log(
          `failed ${subject}: ${error instanceof Error ? error.message : String(error)}` +
            `${error instanceof Error && error.stack ? `\n${error.stack}` : ''}`,
        );
      }
      // Rethrown, always. bullmq decides what a failure means - the retry, the
      // backoff, the attempt count - and swallowing it here would mark a job
      // completed that never did anything.
      throw error;
    }
  };

  /**
   * Built on the first job rather than at import: a child that is spawned and never
   * given work should not open a database connection, and a boot failure is then
   * attributable to a job rather than showing up as a silent exit.
   */
  async #boot(): Promise<{ app: App; dispatcher: JobDispatcher }> {
    // A marker for anything that must behave differently off the request path - a
    // scheduler that should not start twice, a metrics exporter that should not
    // bind a port in every child. Set before the container is built, so a provider
    // can read it in its own constructor.
    process.env['DUNX_JOB_WORKER'] = 'true';

    const app = await AppFactory.create(this.#root);
    // The same selection the parent made, so the two fail identically on the same
    // wiring rather than diverging until a job arrives with no handler.
    const jobs = selectJobs(
      collectModules(this.#root),
      (token) => app.get(token),
      this.#options.queues,
    );
    const dispatcher = new JobDispatcher(
      jobs,
      app.get(QueueOptions).jobTimeoutMs,
    );

    app.get(Logger).info(`Sandboxed worker ready, ${jobs.length} handler(s)`, {
      queues: dispatcher.queues,
      pid: process.pid,
    });

    // Without this the container never tears down and whatever it opened is closed
    // by process exit instead, which is not the same thing for a database with work
    // in flight.
    process.once('SIGTERM', () => {
      void (async () => {
        await this.#options.onShutdown?.(app);
        await app.shutdown();
      })();
    });

    return { app, dispatcher };
  }
}
