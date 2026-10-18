import { Logger, OnEvent } from '@dunx/core';
import { AppReady, OrderPlaced, OrderSettled } from './orders.events.js';

/** Orders above this throw, to show one subscriber failing in isolation. */
export const REVIEW_LIMIT = 1_000;

/**
 * A synchronous handler that hands its async work to `waitUntil`, one that
 * throws, and `once`.
 */
export class Notifications {
  readonly sent: string[] = [];
  #settled = 0;
  #boots = 0;
  #ready = 0;

  constructor(private readonly logger: Logger) {}

  /** Nothing is returned for `emit` to await, so `waitUntil` holds it open. */
  @OnEvent(OrderPlaced)
  notify(event: OrderPlaced): void {
    event.waitUntil(
      Bun.sleep(1).then(() => {
        this.sent.push(event.id);
      }),
    );
  }

  /** The subscribers after this one still run, and the failure lands on the
   * returned dispatch with this method named. */
  @OnEvent(OrderPlaced)
  flagForReview(event: OrderPlaced): void {
    if (event.total <= REVIEW_LIMIT) return;
    throw new Error(`${event.id} is over the ${REVIEW_LIMIT} review limit`);
  }

  @OnEvent(AppReady)
  ready(): void {
    this.#ready += 1;
  }

  @OnEvent(OrderSettled)
  countSettled(): void {
    this.#settled += 1;
  }

  /** Unsubscribes itself after the first delivery. */
  @OnEvent(OrderSettled, { once: true })
  logFirstSettlement(event: OrderSettled): void {
    this.#boots += 1;
    this.logger.info(`first settlement seen: ${event.id}`);
  }

  get settled(): number {
    return this.#settled;
  }

  get firstSettlements(): number {
    return this.#boots;
  }

  get readyCount(): number {
    return this.#ready;
  }
}
