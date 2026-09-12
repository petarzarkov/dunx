import { Counter, Logger, OnEvent } from '@dunx/core';
import { AppReady, OrderPlaced, OrderSettled } from './orders.events.js';

/** Orders above this throw, to show one subscriber failing in isolation. */
export const REVIEW_LIMIT = 1_000;

/**
 * A synchronous handler that hands its async work to `waitUntil`, one that
 * throws, and `once`.
 *
 * Counts go through `Counter` rather than a private field: Bun's parser rejects a
 * read-modify-write on a private field in a class that also has a decorated
 * member. See docs/bun-apis.md.
 */
export class Notifications {
  readonly sent: string[] = [];
  readonly #settled = new Counter();
  readonly #boots = new Counter();
  readonly #ready = new Counter();

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
    this.#ready.inc();
  }

  @OnEvent(OrderSettled)
  countSettled(): void {
    this.#settled.inc();
  }

  /** Unsubscribes itself after the first delivery. */
  @OnEvent(OrderSettled, { once: true })
  logFirstSettlement(event: OrderSettled): void {
    this.#boots.inc();
    this.logger.info(`first settlement seen: ${event.id}`);
  }

  get settled(): number {
    return this.#settled.value;
  }

  get firstSettlements(): number {
    return this.#boots.value;
  }

  get readyCount(): number {
    return this.#ready.value;
  }
}
