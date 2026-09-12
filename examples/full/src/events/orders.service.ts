import { EventBus, type EventDispatch } from '@dunx/core';
import { OrderPlaced } from './orders.events.js';

/**
 * The publisher. It names no subscriber and imports no module that holds one:
 * `EventBusModule` is global, so the only thing this depends on is `EventBus`.
 */
export class Orders {
  #next = 0;

  constructor(private readonly bus: EventBus) {}

  /** `await` on `emit` covers every subscriber, `async` ones included. */
  async place(total: number): Promise<EventDispatch> {
    this.#next += 1;
    return this.bus.emit(new OrderPlaced(`order-${this.#next}`, total));
  }
}
