import { Counter, Gauge, Logger } from '@dunx/core';
import { Cron, Interval, OnceOnBoot, Overlap } from '@dunx/infra/schedule';

/**
 * The three schedule decorators on one class, discovered off the prototype chain
 * with no second registration. Nothing here coordinates across replicas: work
 * that must happen once per fleet is a `@JobHandler`.
 *
 * Counts go through `@dunx/core`'s `Counter` rather than a private field, which
 * also sidesteps Bun 1.4.0 failing to parse a class with both a decorated member
 * and a read-modify-write on a private field. See docs/bun-apis.md.
 */
export class Maintenance {
  readonly #sweeps = new Counter();
  readonly #compactions = new Counter();
  #warmed = false;

  constructor(private readonly logger: Logger) {}

  /** `0` fires on the next macrotask after `onInit`, which is before
   * `Bun.serve` binds - so the first request never sees a cold cache. */
  @OnceOnBoot(0, { name: 'maintenance.warm' })
  warmCaches(): void {
    this.#warmed = true;
    this.logger.info('@OnceOnBoot(0): caches warmed, before listen() resolved');
  }

  /** Ten minutes, so it never fires during a tour. `trigger` runs it now. */
  @Interval(600_000, { name: 'maintenance.sweep' })
  sweepSessions(): number {
    this.#sweeps.inc();
    return this.#sweeps.value;
  }

  /**
   * Minute resolution: `Bun.cron` rejects a sixth field, so sub-minute work is
   * `@Interval`. `overlap` defaults to `skip`, which `Bun.cron` gives for free.
   */
  @Cron('0 3 * * *', { name: 'maintenance.compact' })
  async compactLedger(): Promise<number> {
    await Bun.sleep(1);
    this.#compactions.inc();
    return this.#compactions.value;
  }

  readonly #slow = new Counter();
  /**
   * A `Gauge`, not `#inFlight += 1`. A compound assignment to a private field in
   * a class that also has a decorated member is a `SyntaxError` in Bun's parser,
   * still on 1.4.2 - which is what the note at the top of this class is about,
   * and which this method walked straight into before it was written this way.
   */
  readonly #inFlight = new Gauge();
  readonly #peak = new Gauge();

  /**
   * `overlap: Overlap.CONCURRENT`, which is the half `skip` hides.
   *
   * The default refuses to start a run while the last one is still going, so a
   * handler that outlives its own cadence quietly runs at the rate it can finish.
   * `concurrent` starts anyway, and `maxInFlight` is how you can tell: triggered
   * twice inside its own sleep it reaches 2, where the sweep above stays at 1.
   */
  @Interval(600_000, {
    name: 'maintenance.overlapping',
    overlap: Overlap.CONCURRENT,
  })
  async overlappingWork(): Promise<number> {
    this.#inFlight.inc();
    this.#peak.set(Math.max(this.#peak.value, this.#inFlight.value));
    try {
      await Bun.sleep(40);
      this.#slow.inc();
      return this.#slow.value;
    } finally {
      this.#inFlight.dec();
    }
  }

  get overlapping(): { runs: number; maxInFlight: number } {
    return { runs: this.#slow.value, maxInFlight: this.#peak.value };
  }

  get counts(): { sweeps: number; compactions: number; warmed: boolean } {
    return {
      sweeps: this.#sweeps.value,
      compactions: this.#compactions.value,
      warmed: this.#warmed,
    };
  }
}
