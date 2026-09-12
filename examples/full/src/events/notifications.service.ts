import { Counter, Logger, OnEvent } from '@dunx/core';
import { OrderPlaced, OrderSettled } from './orders.events.js';

/** Orders above this throw, to show one subscriber failing in isolation. */
export const REVIEW_LIMIT = 1_000;

/**
 * Three things one class can show: a synchronous handler that hands its async
 * work to `waitUntil`, a handler that throws, and `once`.
 *
 * Counts go through `Counter` rather than a private field: Bun's parser rejects a
 * read-modify-write on a private field in a class that also has a decorated
 * member. See docs/bun-apis.md.
 */
export class Notifications {
  readonly sent: string[] = [];
  readonly #settled = new Counter();
  readonly #boots = new Counter();

  constructor(private readonly logger: Logger) {}

  /**
   * Synchronous, so nothing is returned for `emit` to await. `waitUntil` is how
   * work started here still holds the dispatch open.
   */
  @OnEvent(OrderPlaced)
  notify(event: OrderPlaced): void {
    event.waitUntil(
      Bun.sleep(1).then(() => {
        this.sent.push(event.id);
      }),
    );
  }

  /**
   * Throwing is contained: the subscribers registered after this one still run,
   * `emit` still resolves, and the failure is on the returned dispatch with this
   * method named.
   */
  @OnEvent(OrderPlaced)
  flagForReview(event: OrderPlaced): void {
    if (event.total <= REVIEW_LIMIT) return;
    throw new Error(`${event.id} is over the ${REVIEW_LIMIT} review limit`);
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
}
