import {
  AppRef,
  collectModules,
  Logger,
  type ModuleRef,
  type OnInit,
  type OnShutdown,
  type ResolvedModule,
  type ScopedResolver,
} from '@dunx/core';
import {
  selectSubscriptions,
  type DiscoveredSubscription,
} from './discover.js';
import { AmqpError, AmqpErrorCode } from './errors.js';
import { AmqpOptions } from './options.js';
import { AmqpSubscriber } from './subscriber.js';

/**
 * Consuming, owned by the container. `onInit` runs once every provider exists, so
 * handlers are there to discover, and `onShutdown` runs in reverse construction
 * order, so consumers drain before the connection they use closes. That ordering
 * is what this exists for.
 *
 * `AppRef` rather than constructor injection: which classes declare an
 * `@AmqpHandler` is not knowable when this is built.
 */
export class AmqpRunner implements OnInit, OnShutdown {
  readonly #ref: AppRef;
  readonly #root: ModuleRef;
  readonly #options: AmqpOptions;
  readonly #logger: Logger;
  #subscriber: AmqpSubscriber | undefined;

  constructor(
    ref: AppRef,
    root: ModuleRef,
    options: AmqpOptions,
    logger: Logger,
  ) {
    this.#ref = ref;
    this.#root = root;
    this.#options = options;
    this.#logger = logger;
  }

  /** The subscriber, once started. Absent until `onInit` has run. */
  get subscriber(): AmqpSubscriber | undefined {
    return this.#subscriber;
  }

  async onInit(): Promise<void> {
    // The gate lives here, not in the module: `forRootAsync` builds its options
    // from a factory, so `consume` is not knowable when providers are declared.
    if (!this.#options.consume) return;

    const app = this.#ref.current;
    const modules = collectModules(this.#root);
    const subscriptions = this.#select(modules, app);
    if (subscriptions === undefined) return;

    this.#subscriber = new AmqpSubscriber(app, subscriptions);
    await this.#subscriber.start();
  }

  /**
   * The handlers to consume for, or `undefined` when `consume: 'if-any'` found
   * none and this process should stand down.
   *
   * Only `NO_HANDLERS` is caught. Two handlers claiming one queue is a different
   * refusal and stays a boot error under every setting - standing down on it would
   * start a process that splits its own deliveries.
   */
  #select(
    modules: readonly ResolvedModule[],
    container: ScopedResolver,
  ): readonly DiscoveredSubscription[] | undefined {
    try {
      return selectSubscriptions(modules, container, undefined);
    } catch (error) {
      const softenable =
        this.#options.consume === 'if-any' &&
        error instanceof AmqpError &&
        error.code === AmqpErrorCode.NO_HANDLERS;
      if (!softenable) throw error;
      this.#logger.warn(
        "consume: 'if-any' and no @AmqpHandler in this module graph, so no " +
          'consumers were opened. This process publishes but consumes nothing.',
      );
      return undefined;
    }
  }

  /** Before the connection closes, which reverse-order teardown gives for free.
   * `stop()` waits for whatever is mid-flight rather than killing it. */
  async onShutdown(): Promise<void> {
    if (this.#subscriber === undefined) return;
    this.#logger.debug(
      'Stopping AMQP consumers before the container tears down',
    );
    await this.#subscriber.stop();
  }
}
