/**
 * One live subscription, and the record of what it has done.
 *
 * Returned by `EventBus.on`, and collected by `EventRegistry` for the handlers
 * `@OnEvent` declared.
 */
export class EventSubscription {
  /** The event class's name, for logs and listings. */
  readonly event: string;
  /** The dispatch name the listener is registered under. */
  readonly type: string;
  /** `Audit.record` for a discovered handler, the function's name otherwise. */
  readonly subscriber: string;
  readonly #controller: AbortController;
  readonly #signal: AbortSignal;
  #handled = 0;
  #failed = 0;
  #lastError: unknown;

  constructor(
    event: string,
    type: string,
    subscriber: string,
    controller: AbortController,
    signal: AbortSignal,
  ) {
    this.event = event;
    this.type = type;
    this.subscriber = subscriber;
    this.#controller = controller;
    this.#signal = signal;
  }

  /** Deliveries that returned, or whose returned promise resolved. */
  get handled(): number {
    return this.#handled;
  }

  /** Deliveries that threw, or whose returned promise rejected. */
  get failed(): number {
    return this.#failed;
  }

  get lastError(): unknown {
    return this.#lastError;
  }

  get active(): boolean {
    // The effective signal, not the controller's: `on` combines the caller's
    // `options.signal` with it, so a caller aborting their own ends the listener
    // while the controller stays untouched. Reading the controller reported a
    // dereferenced subscription as live.
    return !this.#signal.aborted;
  }

  /** Removes the listener. Idempotent, and a later `emit` skips it. */
  unsubscribe(): void {
    this.#controller.abort();
  }

  /**
   * Called by `EventBus` once a delivery has settled, the way
   * `AppRef.attach` is called by `AppFactory`. Nothing else has a reason to.
   */
  settle(failure?: { readonly error: unknown }): void {
    if (failure === undefined) {
      this.#handled += 1;
      return;
    }
    this.#failed += 1;
    this.#lastError = failure.error;
  }
}
