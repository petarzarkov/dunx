/** The label every series past the cap collapses into. */
const OVERFLOW = '(other)';

/** Distinct label sets kept before the collapse. */
const MAX_SERIES = 128;

/**
 * Length-prefixed, so no label holding the separator can forge another pair's
 * key. Never parsed back: the series a factory builds carries its own labels.
 */
const keyOf = (primary: string, secondary: string): string =>
  `${primary.length}:${primary}:${secondary}`;

/**
 * A keyed map of series that stops growing.
 *
 * Both `QueueMetrics` and `RedisMetrics` key on a string the caller chose - a job
 * name handed to `publish()`, a verb handed to `send()` - so an unbounded map
 * holds a histogram per distinct value for the life of the process. Past 128
 * label sets every further one lands in a single `(other)` series.
 *
 * **The ceiling is 129 entries, not 128.** The overflow series takes a slot of its
 * own once something has landed in it, so a snapshot taken after the collapse
 * carries one more series than the cap.
 */
export class CappedSeries<T> {
  readonly #entries = new Map<string, T>();
  readonly #create: (primary: string, secondary: string) => T;

  constructor(create: (primary: string, secondary: string) => T) {
    this.#create = create;
  }

  values(): IterableIterator<T> {
    return this.#entries.values();
  }

  clear(): void {
    this.#entries.clear();
  }

  /**
   * The series for these labels, created on first use. `secondary` defaults to
   * the empty string for a metric keyed on one label.
   */
  for(primary: string, secondary = ''): T {
    const key = keyOf(primary, secondary);
    const existing = this.#entries.get(key);
    if (existing) return existing;
    if (this.#entries.size < MAX_SERIES) {
      const created = this.#create(primary, secondary);
      this.#entries.set(key, created);
      return created;
    }
    const overflowKey = keyOf(OVERFLOW, OVERFLOW);
    const overflow = this.#entries.get(overflowKey);
    if (overflow) return overflow;
    const created = this.#create(OVERFLOW, OVERFLOW);
    this.#entries.set(overflowKey, created);
    return created;
  }
}
