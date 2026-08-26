import {
  AppRef,
  collectModules,
  Logger,
  type InjectionToken,
  type ModuleRef,
  type OnInit,
  type OnShutdown,
  type ResolvedModule,
} from '@dunx/core';
import { JobDispatcher } from './dispatcher.js';
import { selectJobs, type DiscoveredJob } from './discover.js';
import { QueueError, QueueErrorCode } from './errors.js';
import { QueueOptions } from './options.js';
import { QueueConsumer } from './worker.js';

/**
 * Consuming, owned by the container. `QueueModule.forRoot({ consume: true })`
 * binds it and the lifecycle does the rest: `onInit` runs once every provider
 * exists, so handlers are there to discover, and `onShutdown` runs in reverse
 * construction order, so workers stop before the connections they use close.
 *
 * That ordering is why this exists rather than two lines in an entrypoint.
 *
 * `AppRef` rather than constructor injection: which classes declare a
 * `@JobHandler` is not knowable when this is built.
 */
export class QueueRunner implements OnInit, OnShutdown {
  readonly #ref: AppRef;
  readonly #root: ModuleRef;
  readonly #options: QueueOptions;
  readonly #logger: Logger;
  #consumer: QueueConsumer | undefined;

  constructor(
    ref: AppRef,
    root: ModuleRef,
    options: QueueOptions,
    logger: Logger,
  ) {
    this.#ref = ref;
    this.#root = root;
    this.#options = options;
    this.#logger = logger;
  }

  /** The consumer, once started. Absent until `onInit` has run. */
  get consumer(): QueueConsumer | undefined {
    return this.#consumer;
  }

  async onInit(): Promise<void> {
    // The gate lives here, not in the module: `forRootAsync` builds its options
    // from a factory, so `consume` is not knowable when providers are declared.
    if (!this.#options.consume) return;

    /**
     * **Never in a sandbox child.** A child boots the same module graph, so
     * `consume: true` would have it open its own workers and pull jobs it was
     * forked to run one of - the queue consuming itself, one fork deep, forever.
     *
     * `JobProcessor` sets this before it builds the container, which is the same
     * trick the marker exists for elsewhere: code that must behave differently off
     * the request path needs to be able to ask.
     */
    if (process.env['DUNX_JOB_WORKER'] === 'true') {
      this.#logger.debug(
        'Not opening workers: this container is a sandboxed job child',
      );
      return;
    }

    const app = this.#ref.current;
    const modules = collectModules(this.#root);
    const jobs = this.#select(modules, (token) => app.get(token));
    if (jobs === undefined) return;
    const dispatcher = new JobDispatcher(jobs, this.#options.jobTimeoutMs);

    this.#consumer = new QueueConsumer(
      app,
      dispatcher,
      jobs,
      dispatcher.queues,
    );
    /**
     * **A broker that is down degrades; it does not fail boot.**
     *
     * This container is usually also serving HTTP - that is the point of
     * `consume` - and refusing to start the web tier because a queue is
     * unreachable trades a partial outage for a total one. It is the same call
     * `@dunx/infra/redis` and the websocket relay already make.
     *
     * At `error`, not `warn`: nothing is consuming, which is a real incident even
     * though the process is up.
     */
    try {
      await this.#consumer.start();
    } catch (error) {
      this.#logger.error(
        `Queue workers could not start against ${this.#options.redactedUrl}. ` +
          'This process is serving but consuming nothing.',
        error,
      );
    }
  }

  /**
   * The handlers to consume for, or `undefined` when `consume: 'if-any'` found
   * none and this process should stand down.
   *
   * Only `NO_HANDLERS` is caught. Two handlers claiming one `(queue, name)` is a
   * different refusal and stays a boot error under every setting - standing down
   * on it would start a process that consumes an ambiguous graph.
   */
  #select(
    modules: readonly ResolvedModule[],
    resolve: (token: InjectionToken<unknown>) => unknown,
  ): readonly DiscoveredJob[] | undefined {
    try {
      return selectJobs(modules, resolve, undefined);
    } catch (error) {
      const softenable =
        this.#options.consume === 'if-any' &&
        error instanceof QueueError &&
        error.code === QueueErrorCode.NO_HANDLERS;
      if (!softenable) throw error;
      this.#logger.warn(
        "consume: 'if-any' and no @JobHandler in this module graph, so no " +
          'workers were opened. This process publishes but consumes nothing.',
      );
      return undefined;
    }
  }

  /**
   * Before the connections close, which reverse-order teardown gives for free: this
   * is constructed after `QueueConnection` because it depends on it, so it is torn
   * down first. `stop()` waits for whatever is mid-flight rather than killing it.
   */
  async onShutdown(): Promise<void> {
    if (this.#consumer === undefined) return;
    this.#logger.debug(
      'Stopping queue workers before the container tears down',
    );
    await this.#consumer.stop();
  }
}
