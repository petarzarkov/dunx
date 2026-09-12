import type { Ctor } from '../di/token.js';
import type { Logger } from '../logger/logger.js';
import type { EventHandler } from './decorators.js';
import { EventDispatch, type EventFailure } from './dispatch.js';
import { eventName, type AppEvent } from './event.js';
import { EventSubscription } from './subscription.js';

export interface SubscribeOptions {
  /** Unsubscribe after the first delivery. */
  readonly once?: boolean;
  /**
   * Unsubscribes when this aborts, alongside the returned subscription's own
   * `unsubscribe()`. For a listener whose lifetime is a request or a connection.
   */
  readonly signal?: AbortSignal;
  /** The name this subscription is logged and listed under. */
  readonly as?: string;
}

/** What one `dispatchEvent` collected, while it is still running. */
interface Dispatching {
  handled: number;
  readonly work: Promise<unknown>[];
  readonly failures: EventFailure[];
}

const dispatching = (): Dispatching => ({
  handled: 0,
  work: [],
  failures: [],
});

/**
 * Publish and subscribe, in process, over one `EventTarget`.
 *
 * ```ts
 * class Orders {
 *   constructor(private readonly bus: EventBus) {}
 *
 *   async place(total: number): Promise<void> {
 *     await this.bus.emit(new OrderPlaced(crypto.randomUUID(), total));
 *   }
 * }
 * ```
 *
 * `EventBusModule` binds this globally, so a subscriber's module does not import
 * the publisher's.
 *
 * `emit` calls `dispatchEvent`: every listener runs synchronously, in
 * registration order, and the returned promise then waits for what they left
 * outstanding. `dispatchEvent` discards a listener's return value; this collects
 * it, so an `async` handler is awaited with no `waitUntil`.
 *
 * In process and single node. A subscriber that must survive a restart or fan out
 * across replicas is a `@JobHandler` in `@dunx/infra/queue`; a websocket message
 * every node must send is `PubSubRelay` in `@dunx/http`.
 */
export class EventBus {
  readonly #target = new EventTarget();
  readonly #logger: Logger;
  /**
   * The dispatch in progress. `dispatchEvent` runs its listeners synchronously, so
   * a listener always reads the one it belongs to; a handler that emits again
   * saves and restores around the nested call. The idle value is never read back.
   */
  #current: Dispatching = dispatching();

  constructor(logger: Logger) {
    this.#logger = logger;
  }

  /**
   * Subscribes `handler` to `event` and hands back the subscription.
   *
   * Removal is `AbortSignal`: the subscription owns a controller, and
   * `options.signal` is combined with it, so either one ends the listener.
   */
  on<E extends AppEvent>(
    event: Ctor<E>,
    handler: EventHandler<E>,
    options: SubscribeOptions = {},
  ): EventSubscription {
    const controller = new AbortController();
    const type = eventName(event);
    const signal =
      options.signal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, options.signal]);
    const subscription = new EventSubscription(
      event.name,
      type,
      options.as ?? (handler.name === '' ? 'anonymous' : handler.name),
      controller,
      signal,
    );

    this.#target.addEventListener(
      type,
      (raw: Event) => {
        // Aborting is the whole removal, rather than `EventTarget`'s own `once`
        // alongside it: two mechanisms for one job, and its own leaves the
        // controller untouched so a spent subscription reported `active: true`.
        // Aborted before the handler runs, so a throwing one lands there too;
        // the listener is already executing, so this delivery still completes.
        if (options.once === true) controller.abort();
        this.#deliver(
          subscription,
          handler as EventHandler<AppEvent>,
          raw as AppEvent,
        );
      },
      { signal },
    );

    return subscription;
  }

  /** `on` with `once: true`. */
  once<E extends AppEvent>(
    event: Ctor<E>,
    handler: EventHandler<E>,
    options: SubscribeOptions = {},
  ): EventSubscription {
    return this.on(event, handler, { ...options, once: true });
  }

  /**
   * Delivers `event` to every subscriber, then resolves once their work has
   * settled. It does not reject: read `failures`, or call `throwIfFailed()`.
   */
  async emit<E extends AppEvent>(event: E): Promise<EventDispatch> {
    const label = event.constructor.name;
    const collected = dispatching();
    const previous = this.#current;
    this.#current = collected;
    // Where this dispatch's `waitUntil` work starts. `pending` lives on the event
    // instance, so re-emitting one would otherwise re-read every promise an
    // earlier dispatch settled and report its failures a second time.
    const from = event.pending.length;
    try {
      this.#target.dispatchEvent(event);
    } finally {
      this.#current = previous;
    }

    await this.#settle(event, collected, from);

    for (const { subscriber, error } of collected.failures) {
      this.#logger.error(`${subscriber} failed handling ${label}`, error);
    }
    return new EventDispatch(label, collected.handled, collected.failures);
  }

  /**
   * Waits out the handlers' own promises and everything they handed to
   * `waitUntil`, looping while either list is still growing - a handler may await
   * one thing and then register another.
   */
  async #settle(
    event: AppEvent,
    collected: Dispatching,
    from = 0,
  ): Promise<void> {
    let handlers = 0;
    let waited = from;

    for (;;) {
      const round: Promise<unknown>[] = [];
      for (; handlers < collected.work.length; handlers += 1) {
        round.push(collected.work[handlers]!);
      }
      for (; waited < event.pending.length; waited += 1) {
        round.push(
          Promise.resolve(event.pending[waited]).catch((error: unknown) => {
            collected.failures.push({ subscriber: 'waitUntil', error });
          }),
        );
      }
      if (round.length === 0) return;
      // Every entry is already failure-free: the handler's promise was wrapped
      // when it was collected, and waitUntil's was wrapped just above.
      await Promise.all(round);
    }
  }

  #deliver(
    subscription: EventSubscription,
    handler: EventHandler<AppEvent>,
    event: AppEvent,
  ): void {
    const collected = this.#current;
    let returned: unknown;
    try {
      returned = handler(event);
    } catch (error) {
      this.#failed(subscription, collected, error);
      return;
    }

    // Thenable, not `instanceof Promise`: that misses a promise from another
    // realm and any promise-like a library returns, and treating one as a
    // synchronous return resolves `emit` before the handler has finished, which
    // is the exact footgun auto-collecting the return value exists to remove.
    if (
      typeof (returned as PromiseLike<unknown> | undefined)?.then !== 'function'
    ) {
      subscription.settle();
      collected.handled += 1;
      return;
    }

    collected.work.push(
      Promise.resolve(returned).then(
        () => {
          subscription.settle();
          collected.handled += 1;
        },
        (error: unknown) => {
          this.#failed(subscription, collected, error);
        },
      ),
    );
  }

  #failed(
    subscription: EventSubscription,
    collected: Dispatching,
    error: unknown,
  ): void {
    subscription.settle({ error });
    collected.failures.push({ subscriber: subscription.subscriber, error });
  }
}
