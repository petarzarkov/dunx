let issued = 0;

/**
 * The `EventTarget` type string a class dispatches under, assigned on first use
 * and kept in a `WeakMap`.
 *
 * Not `ctor.name`: a minifier rewrites it, and two features are free to both call
 * theirs `Created`. The counter is what makes the string unique; the class name is
 * carried along so `event.type` still reads as something in a log.
 */
const names = new WeakMap<object, string>();

export const eventName = (ctor: object): string => {
  const existing = names.get(ctor);
  if (existing !== undefined) return existing;

  issued += 1;
  const assigned = `dunx.event.${issued}.${(ctor as { name?: string }).name ?? ''}`;
  names.set(ctor, assigned);
  return assigned;
};

/**
 * The base class every published event extends.
 *
 * ```ts
 * export class OrderPlaced extends AppEvent {
 *   constructor(readonly id: string, readonly total: number) {
 *     super();
 *   }
 * }
 * ```
 *
 * `super()` takes no arguments: the dispatch name comes from `new.target`, so a
 * subclass never states it. Extending `Event` is what lets `EventBus` be an
 * `EventTarget` rather than a listener table of its own.
 *
 * A handler that returns a promise has it awaited by `emit`. `waitUntil` covers
 * the other case: work a synchronous handler starts and does not return.
 */
export class AppEvent extends Event {
  readonly #pending: Promise<unknown>[] = [];

  constructor() {
    super(eventName(new.target));
  }

  /**
   * Holds `emit` open until `work` settles. Call it synchronously from inside a
   * handler; a call made after the handler has already returned arrives too late
   * for the dispatch that is waiting.
   */
  waitUntil(work: Promise<unknown>): void {
    this.#pending.push(work);
  }

  /** What `waitUntil` has collected so far. `EventBus.emit` reads it. */
  get pending(): readonly Promise<unknown>[] {
    return this.#pending;
  }
}
