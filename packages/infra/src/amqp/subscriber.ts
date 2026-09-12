import { Logger, RequestContext, type App } from '@dunx/core';
import type { Consumer, ConsumerProps } from 'rabbitmq-client';
import { ErrorThrottle } from '../error-throttle.js';
import { AmqpConnection } from './connection.js';
import { AmqpDispatcher, type DispatchSettings } from './dispatcher.js';
import type { DiscoveredSubscription } from './discover.js';
import { AmqpError, AmqpErrorCode } from './errors.js';
import { AmqpOptions } from './options.js';

/** How often one queue's consumer may report an error. */
const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * The props one handler's consumer is opened with: the module defaults, the
 * handler's own `consumer` over them, and the convenience `exchange` pair
 * appended to whatever bindings either declared rather than replacing them.
 */
/** One nested option object over another, or nothing where neither side has one:
 * `qos: {}` is not the same as no `qos`, which skips `basicQos` entirely. */
const nested = <T extends object>(
  base: T | undefined,
  over: T | undefined,
): { value: T } | undefined =>
  base === undefined && over === undefined
    ? undefined
    : { value: { ...base, ...over } as T };

export const consumerProps = (
  defaults: Omit<ConsumerProps, 'queue'>,
  found: DiscoveredSubscription,
): ConsumerProps => {
  const qos = nested(defaults.qos, found.consumer?.qos);
  const queueOptions = nested(
    defaults.queueOptions,
    found.consumer?.queueOptions,
  );
  const merged: ConsumerProps = {
    ...defaults,
    ...found.consumer,
    queue: found.queue,
    // Key by key, for the reason `AmqpOptions` does it: a handler overriding one
    // field of either would otherwise drop the module-wide rest.
    ...(qos === undefined ? {} : { qos: qos.value }),
    ...(queueOptions === undefined ? {} : { queueOptions: queueOptions.value }),
  };
  if (found.exchange === undefined) return merged;

  return {
    ...merged,
    exchanges: [
      ...(merged.exchanges ?? []),
      {
        exchange: found.exchange,
        type: found.exchangeType ?? 'topic',
        durable: true,
      },
    ],
    queueBindings: [
      ...(merged.queueBindings ?? []),
      {
        exchange: found.exchange,
        queue: found.queue,
        routingKey: found.routingKey ?? found.queue,
      },
    ],
  };
};

/** The consuming half, with no `App` of its own: one `Consumer` per handler,
 * each on its own channel over the one connection. */
export class AmqpSubscriber {
  readonly subscriptions: readonly DiscoveredSubscription[];
  readonly #connection: AmqpConnection;
  readonly #options: AmqpOptions;
  readonly #logger: Logger;
  readonly #dispatcher: AmqpDispatcher;
  readonly #consumers: Consumer[] = [];
  #started = false;
  #stopping: Promise<void> | undefined;

  constructor(app: App, subscriptions: readonly DiscoveredSubscription[]) {
    this.subscriptions = subscriptions;
    this.#connection = app.get(AmqpConnection);
    this.#options = app.get(AmqpOptions);
    this.#logger = app.get(Logger);
    this.#dispatcher = new AmqpDispatcher(
      this.#logger,
      app.get(RequestContext),
    );
  }

  /** Every queue this will consume, in discovery order. */
  get queues(): readonly string[] {
    return this.subscriptions.map((found) => found.queue);
  }

  /**
   * Opens a consumer per handler and waits `readyTimeoutMs` for each to report
   * itself set up.
   *
   * A consumer that does not report in time is left running and the line says so:
   * the library keeps retrying the setup, so the alternative is refusing to boot a
   * process whose broker is briefly unreachable - and this container is usually
   * also serving HTTP. **A broker that is down degrades; it does not fail boot.**
   */
  async start(): Promise<readonly string[]> {
    if (this.#started) {
      throw new AmqpError(
        AmqpErrorCode.INVALID_STATE,
        'start() has already run. One consumer per queue per process.',
      );
    }
    this.#started = true;

    try {
      // Inside the try: `createConsumer` can throw on the second subscription
      // after the first has already opened a channel, and one left out of the
      // teardown below is a channel nothing closes.
      const pending = this.subscriptions.map((found) => this.#open(found));
      await Promise.all(
        pending.map(async ({ found, ready }) => {
          const settled = await ready;
          this.#logger.info(
            settled
              ? `Started AMQP consumer for queue: ${found.queue}`
              : `AMQP consumer for queue ${found.queue} is not set up yet and is ` +
                  'still retrying. This process is serving but consuming nothing ' +
                  'from it.',
            {
              queue: found.queue,
              url: this.#options.redactedUrl,
              handler: `${found.provider}.${found.method}`,
              ...(found.exchange === undefined
                ? {}
                : {
                    exchange: found.exchange,
                    routingKey: found.routingKey ?? found.queue,
                  }),
            },
          );
        }),
      );
    } catch (error) {
      // Whatever did open is closed before the error leaves, bounded the same way
      // a shutdown drain is.
      await this.stop();
      throw error;
    }
    return this.queues;
  }

  /**
   * Stops consuming and waits for whatever is mid-flight, bounded by
   * `drainTimeoutMs`. Idempotent.
   *
   * `Consumer.close()` closes the channel once every pending handler has settled,
   * measured at 701 ms for three handlers sleeping a second, so this runs before
   * the providers tear down. The bound is because that same call waits
   * `acquireTimeout` when the connection is down.
   */
  async stop(): Promise<void> {
    this.#stopping ??= (async () => {
      const open = this.#consumers.splice(0);
      await Promise.all(open.map((consumer) => this.#drain(consumer)));
    })();
    return this.#stopping;
  }

  /** Bounded, and never rejecting: one consumer that will not close must not stop
   * the rest of teardown, which is what closes the socket under it. */
  async #drain(consumer: Consumer): Promise<void> {
    const timedOut = Symbol('timed out');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        consumer.close(),
        new Promise<symbol>((resolve) => {
          timer = setTimeout(
            () => resolve(timedOut),
            this.#options.drainTimeoutMs,
          );
        }),
      ]);
      if (outcome === timedOut) {
        this.#logger.warn(
          `an AMQP consumer on ${consumer.queue} did not drain within ` +
            `${this.#options.drainTimeoutMs} ms`,
        );
      }
    } catch (error) {
      this.#logger.warn('an AMQP consumer failed to close', error);
    } finally {
      // The loser of the race stays pending: a consumer that closed at once would
      // otherwise hold the loop open for the whole window.
      clearTimeout(timer);
    }
  }

  #open(found: DiscoveredSubscription): {
    found: DiscoveredSubscription;
    ready: Promise<boolean>;
  } {
    const props = consumerProps(this.#options.consumer, found);
    const settings: DispatchSettings = {
      requeue: props.requeue ?? true,
      timeoutMs: this.#options.handlerTimeoutMs,
    };

    const consumer = this.#connection.createConsumer(props, (message) =>
      this.#dispatcher.dispatch(found, settings, message),
    );
    this.#consumers.push(consumer);

    // Throttled, not deduplicated: a later outage still gets reported, and a
    // broker that is down emits on every retry.
    const report = new ErrorThrottle(ERROR_LOG_INTERVAL_MS);
    consumer.on('error', (error: unknown) => {
      if (report.allows()) {
        this.#logger.error(`AMQP consumer error on ${found.queue}`, error);
      }
    });

    return { found, ready: this.#waitForReady(consumer) };
  }

  /** Whether the consumer reported itself set up within the window. */
  async #waitForReady(consumer: Consumer): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.#options.readyTimeoutMs);
        timer.unref?.();
        consumer.once('ready', () => resolve(true));
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
