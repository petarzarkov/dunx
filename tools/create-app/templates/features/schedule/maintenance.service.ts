import { Logger } from '@dunx/core';
import { Cron, Interval, OnceOnBoot, Overlap } from '@dunx/infra/schedule';

/**
 * The three schedule decorators on one class, discovered off the prototype chain
 * with no second registration. Nothing here coordinates across replicas: work
 * that must happen once per fleet is a `@JobHandler`.
 */
export class Maintenance {
  #sweeps = 0;
  #compactions = 0;
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
    return ++this.#sweeps;
  }

  /**
   * Minute resolution: `Bun.cron` rejects a sixth field, so sub-minute work is
   * `@Interval`. `overlap` defaults to `skip`, which `Bun.cron` gives for free.
   */
  @Cron('0 3 * * *', { name: 'maintenance.compact' })
  async compactLedger(): Promise<number> {
    await Bun.sleep(1);
    return ++this.#compactions;
  }

  #slow = 0;
  #inFlight = 0;
  #peak = 0;

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
    this.#peak = Math.max(this.#peak, ++this.#inFlight);
    try {
      await Bun.sleep(40);
      return ++this.#slow;
    } finally {
      this.#inFlight -= 1;
    }
  }

  get overlapping(): { runs: number; maxInFlight: number } {
    return { runs: this.#slow, maxInFlight: this.#peak };
  }

  get counts(): { sweeps: number; compactions: number; warmed: boolean } {
    return {
      sweeps: this.#sweeps,
      compactions: this.#compactions,
      warmed: this.#warmed,
    };
  }
}
