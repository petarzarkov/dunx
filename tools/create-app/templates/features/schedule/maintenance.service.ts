import { Logger } from '@dunx/core';
import { Cron, Interval, OnceOnBoot } from '@dunx/infra/schedule';

/**
 * The three decorators, on one class.
 *
 * The runner finds them by walking the prototype chains of the classes the modules
 * already declare, so none of these needs a second registration - the same
 * discovery routes, gateways and `@JobHandler` use.
 *
 * Nothing here is single-node-unsafe on purpose: two replicas would both run every
 * one of these, because nothing in `@dunx/infra/schedule` coordinates. Work that
 * must happen once across a fleet is a job, which is `@JobHandler` and bullmq.
 */
/**
 * Counters are written as `x = x + 1` rather than `x += 1`, and that is not style.
 * Bun 1.4.0 refuses to parse a class that has both a decorated member and a
 * read-modify-write on a private field - `+=`, `++` and `??=` alike - with a
 * `SyntaxError` naming neither. See docs/bun-apis.md.
 */
export class Maintenance {
  #sweeps = 0;
  #compactions = 0;
  #warmed = false;

  constructor(private readonly logger: Logger) {}

  /**
   * `0`, so it fires on the next macrotask after the container is ready - and
   * "ready" is `onInit`, which is the latest hook there is and runs **before**
   * `Bun.serve` binds. Measured: this has already run by the time `listen()`
   * resolves, so the first request never sees a cold cache.
   */
  @OnceOnBoot(0, { name: 'maintenance.warm' })
  warmCaches(): void {
    this.#warmed = true;
    this.logger.info('@OnceOnBoot(0): caches warmed, before listen() resolved');
  }

  /**
   * Every ten minutes, so it does not fire during a tour or a suite. `trigger`
   * runs it now, which is what makes a schedule testable without waiting.
   */
  @Interval(600_000, { name: 'maintenance.sweep' })
  sweepSessions(): number {
    this.#sweeps = this.#sweeps + 1;
    return this.#sweeps;
  }

  /**
   * Minute resolution: `Bun.cron` rejects a sixth field with "seconds are not
   * supported", so anything sub-minute is `@Interval`.
   *
   * `overlap` is `skip` by default, which is what `Bun.cron` does for free - it
   * computes the next fire only once the returned promise settles.
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
