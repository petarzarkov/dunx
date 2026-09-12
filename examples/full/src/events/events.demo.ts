import { EventBus, EventRegistry, Logger } from '@dunx/core';
import { Audit } from './audit.service.js';
import { Notifications, REVIEW_LIMIT } from './notifications.service.js';
import { OrderPlaced } from './orders.events.js';
import { Orders } from './orders.service.js';
import { Startup } from './startup.service.js';

/**
 * What one `emit` does: who it reaches, what it waits for, and what a failing
 * subscriber costs the publisher.
 */
export class EventsDemo {
  constructor(
    private readonly logger: Logger,
    private readonly bus: EventBus,
    private readonly registry: EventRegistry,
    private readonly orders: Orders,
    private readonly audit: Audit,
    private readonly notifications: Notifications,
    private readonly startup: Startup,
  ) {}

  async demonstrate(): Promise<void> {
    for (const entry of this.registry.list()) {
      this.logger.info(`${entry.event.padEnd(13)} <- ${entry.subscriber}`);
    }

    // EventsModule is imported before EventBusModule, so EventRegistry is built
    // after everything here. Wiring runs in its own pass before the first onInit.
    this.logger.info(
      `emit(AppReady) from onInit reached ${this.startup.reached} subscriber(s), ` +
        'with EventBusModule imported last',
    );

    const ok = await this.orders.place(120);
    this.logger.info(
      `emit(OrderPlaced) -> ${ok.handled} handled, ${ok.failures.length} failed`,
    );
    // Both were written while `emit` was still outstanding: one by an async
    // handler, one by a sync handler that used waitUntil.
    this.logger.info(
      `after await: ${this.audit.rows.length} audit row(s), ` +
        `${this.notifications.sent.length} notification(s), ` +
        `${this.notifications.settled} OrderSettled seen`,
    );

    const over = await this.orders.place(REVIEW_LIMIT + 1);
    for (const failure of over.failures) {
      this.logger.info(
        `${failure.subscriber} threw, and the dispatch carried it: ` +
          String(failure.error),
      );
    }
    this.logger.info(
      `the other subscribers still ran -> ${over.handled} handled, ` +
        `${this.audit.rows.length} audit rows in total`,
    );

    // @OnEvent is the declarative half; `on()` is the imperative one, for a
    // listener whose lifetime is shorter than the process.
    const seen: string[] = [];
    const subscription = this.bus.on(
      OrderPlaced,
      (event) => seen.push(event.id),
      { as: 'EventsDemo.adhoc' },
    );
    await this.orders.place(10);
    subscription.unsubscribe();
    await this.orders.place(11);
    this.logger.info(
      `on() saw ${seen.length}, then unsubscribe() -> active=${subscription.active}`,
    );

    this.logger.info(
      `@OnEvent({ once: true }) fired ${this.notifications.firstSettlements} time(s) ` +
        `across ${this.notifications.settled} settlements`,
    );
  }
}
