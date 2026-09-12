export interface EventFailure {
  /** The subscriber that threw, or `waitUntil` for work one of them registered. */
  readonly subscriber: string;
  readonly error: unknown;
}

/**
 * What one `emit` did, once every handler and everything they registered with
 * `waitUntil` has settled.
 *
 * `emit` does not reject. A subscriber the publisher has never heard of must not
 * be able to fail the publisher, and one handler throwing must not stop the rest,
 * so failures are collected here and logged at `error` naming the subscriber.
 * `throwIfFailed()` is the opt-in for a caller that does want them.
 */
export class EventDispatch {
  /**
   * The event class's name, for reading. A display label rather than an
   * identity: a build that mangles class names can collapse two of them onto
   * one string. Routing never uses it - `EventBus` keys on the registry behind
   * `eventName`, which issues a distinct id per constructor.
   */
  readonly event: string;
  /** Subscribers that ran to completion. */
  readonly handled: number;
  readonly failures: readonly EventFailure[];

  constructor(
    event: string,
    handled: number,
    failures: readonly EventFailure[],
  ) {
    this.event = event;
    this.handled = handled;
    this.failures = failures;
  }

  get ok(): boolean {
    return this.failures.length === 0;
  }

  /** One failure rethrown as itself, several as an `AggregateError`. */
  throwIfFailed(): void {
    if (this.failures.length === 0) return;
    const errors = this.failures.map((failure) => failure.error);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(
      errors,
      `${errors.length} subscribers of ${this.event} failed`,
    );
  }
}
