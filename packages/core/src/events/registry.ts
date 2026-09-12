import { AppRef } from '../di/app.js';
import { discoverMarked } from '../di/marked.js';
import { collectModules, ROOT_MODULE, type ModuleRef } from '../di/module.js';
import type { OnInit } from '../di/lifecycle.js';
import type { Ctor } from '../di/token.js';
import { Logger } from '../logger/logger.js';
import { EventBus } from './bus.js';
import type { EventHandler } from './decorators.js';
import { eventName, type AppEvent } from './event.js';
import { eventHandlerMetaOf, type EventHandlerMeta } from './marker.js';
import type { EventSubscription } from './subscription.js';

/**
 * Every `@OnEvent` in the module graph, subscribed at boot and listed afterwards.
 *
 * `AppRef` rather than constructor injection for the handlers: which classes
 * declare one is not knowable when this is built, so the tokens cannot be named in
 * an `inject` list. It is read in `onInit`, the only point at which that is legal.
 *
 * Handlers are wired during `onInit`, so an event emitted from a constructor
 * reaches nobody. Emit from `onInit` or later.
 */
export class EventRegistry implements OnInit {
  readonly #ref: AppRef;
  readonly #root: ModuleRef;
  readonly #bus: EventBus;
  readonly #logger: Logger;
  readonly #subscriptions: EventSubscription[] = [];

  constructor(ref: AppRef, root: ModuleRef, bus: EventBus, logger: Logger) {
    this.#ref = ref;
    this.#root = root;
    this.#bus = bus;
    this.#logger = logger;
  }

  onInit(): void {
    const app = this.#ref.current;
    const found = discoverMarked<EventHandlerMeta, EventHandler<AppEvent>>(
      collectModules(this.#root),
      (token, from) => app.get(token, from),
      eventHandlerMetaOf,
    );

    for (const { provider, method, meta, handler } of found) {
      this.#subscriptions.push(
        this.#bus.on(meta.event, handler, {
          as: `${provider}.${method}`,
          ...(meta.once === true ? { once: true } : {}),
        }),
      );
    }

    if (this.#subscriptions.length === 0) return;
    // One entry naming everything subscribed, which is how "is my handler wired"
    // gets answered from production rather than by reading the source.
    this.#logger.info(`Subscribed ${this.#subscriptions.length} handler(s)`, {
      handlers: this.#subscriptions.map((entry) => ({
        event: entry.event,
        subscriber: entry.subscriber,
      })),
    });
  }

  /** What `@OnEvent` declared, in discovery order. */
  list(): readonly EventSubscription[] {
    return [...this.#subscriptions];
  }

  /** The discovered subscriptions for one event class. */
  subscribersOf(event: Ctor<AppEvent>): readonly EventSubscription[] {
    const type = eventName(event);
    return this.#subscriptions.filter((entry) => entry.type === type);
  }
}

/** The tokens the registry needs, in constructor order. */
export const EVENT_REGISTRY_DEPS = [
  AppRef,
  ROOT_MODULE,
  EventBus,
  Logger,
] as const;
