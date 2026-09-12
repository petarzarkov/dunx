import { EventBus, OnEvent } from '@dunx/core';
import { OrderPlaced, OrderSettled } from './orders.events.js';

export interface AuditRow {
  readonly id: string;
  readonly total: number;
}

/**
 * An `async` handler. `emit` collects the promise it returns, so the row below is
 * written before `await bus.emit(...)` hands control back to the publisher.
 */
export class Audit {
  readonly rows: AuditRow[] = [];

  constructor(private readonly bus: EventBus) {}

  @OnEvent(OrderPlaced)
  async record(event: OrderPlaced): Promise<void> {
    await Bun.sleep(1);
    this.rows.push({ id: event.id, total: event.total });
    // A handler may publish. The nested emit is awaited here, so the outer one
    // does not resolve until this chain has run out.
    await this.bus.emit(new OrderSettled(event.id));
  }
}
