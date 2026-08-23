import { Logger } from '@dunx/core';
import { Cron, Interval, OnceOnBoot } from '@dunx/infra/schedule';

/**
 * The three schedule decorators on one class, discovered off the prototype chain
 * with no second registration. Nothing here coordinates across replicas: work
 * that must happen once per fleet is a `@JobHandler`.
 *
 * Counters are `x = x + 1` rather than `x += 1` because Bun 1.4.0 fails to parse
 * a class with both a decorated member and a read-modify-write on a private
 * field. See docs/bun-apis.md.
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
    this.#sweeps = this.#sweeps + 1;
    return this.#sweeps;
  }

  /**
   * Minute resolution: `Bun.cron` rejects a sixth field, so sub-minute work is
   * `@Interval`. `overlap` defaults to `skip`, which `Bun.cron` gives for free.
   */
  @Cron('0 3 * * *', { name: 'maintenance.compact' })
  async compactLedger(): Promise<number> {
    await Bun.sleep(1);
    this.#compactions = this.#compactions + 1;
    return this.#compactions;
  }

  get counts(): { sweeps: number; compactions: number; warmed: boolean } {
    return {
      sweeps: this.#sweeps,
      compactions: this.#compactions,
      warmed: this.#warmed,
    };
  }
}
