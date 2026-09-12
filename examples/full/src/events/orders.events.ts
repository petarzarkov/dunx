import { AppEvent } from '@dunx/core';

/**
 * The events this feature publishes. A class per event, so a handler's parameter
 * type is the payload contract and a renamed field is a compile error at every
 * subscriber.
 *
 * `super()` takes no arguments: `AppEvent` reads the dispatch name off
 * `new.target`, so a subclass never states a string anywhere.
 */
export class OrderPlaced extends AppEvent {
  constructor(
    readonly id: string,
    readonly total: number,
  ) {
    super();
  }
}

/** Published once the audit row exists, so the two are visibly ordered. */
export class OrderSettled extends AppEvent {
  constructor(readonly id: string) {
    super();
  }
}
