import type { Ctor } from '../di/token.js';
import type { AppEvent } from './event.js';
import { markEventHandler } from './marker.js';

export type EventHandler<E extends AppEvent> = (event: E) => unknown;

export interface OnEventOptions {
  /** Unsubscribe after the first delivery. */
  readonly once?: boolean;
}

/**
 * Subscribes a method to `event`, for as long as the app runs.
 *
 * ```ts
 * export class Audit {
 *   @OnEvent(OrderPlaced)
 *   async record(event: OrderPlaced): Promise<void> {
 *     await this.rows.insert(event.id);
 *   }
 * }
 * ```
 *
 * The method's parameter has to accept the event class, so a rename that changes
 * the payload is a compile error at the handler rather than a field that reads
 * `undefined`.
 *
 * There is no class decorator to go with it. `EventRegistry` finds marked methods
 * by walking the prototype chains of the classes the modules already declare, so a
 * handler needs no second registration and an abstract base's marked methods are
 * inherited by every subclass. The class has to be a `providers` or `controllers`
 * entry somewhere in the graph: a value or factory provider is not scanned.
 */
export const OnEvent =
  <E extends AppEvent>(event: Ctor<E>, options: OnEventOptions = {}) =>
  <T extends EventHandler<E>>(value: T): T => {
    markEventHandler(value, {
      event: event as Ctor<AppEvent>,
      ...(options.once === true ? { once: true } : {}),
    });
    return value;
  };
