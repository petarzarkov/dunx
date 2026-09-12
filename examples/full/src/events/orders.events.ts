import { AppEvent } from '@dunx/core';

/**
 * A class per event, so a handler's parameter type is the payload contract.
 * `super()` takes no arguments: the dispatch name comes off `new.target`.
 */
export class OrderPlaced extends AppEvent {
  constructor(
    readonly id: string,
    readonly total: number,
  ) {
    super();
  }
}

export class OrderSettled extends AppEvent {
  constructor(readonly id: string) {
    super();
  }
}

/** Published from a provider's `onInit`. */
export class AppReady extends AppEvent {}
