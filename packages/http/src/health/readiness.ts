import type { OnDrain } from '@dunx/core';

export interface ReadinessOptionsInit {
  /**
   * How long to keep failing readiness after the drain starts, before the server
   * stops accepting. Default `0`.
   *
   * The window exists because a load balancer notices a failing probe on its own
   * schedule: with a 2 second probe interval and a 3 failure threshold, traffic can
   * arrive for 6 seconds after the pod has decided to go. Set it to a few probe
   * intervals and the pod stops receiving before the socket closes, which is the
   * whole reason this phase runs before `server.stop()`.
   */
  readonly drainDelayMs?: number;
}

/** A class, so it is a recordable constructor parameter type. */
export class ReadinessOptions {
  readonly drainDelayMs: number;

  constructor(init: ReadinessOptionsInit = {}) {
    this.drainDelayMs = Math.max(0, init.drainDelayMs ?? 0);
  }
}

/**
 * Whether this process wants traffic.
 *
 * Injectable, so a handler can pull the pod out of rotation for a migration and put
 * it back. `hold` and `release` are for that; `onDrain` is for shutdown and does not
 * release.
 *
 * This is what `OnDrain` was added to `@dunx/core` for. `HttpApplication.shutdown()`
 * stopped the server before running any hook, so a readiness flip in `onShutdown`
 * answered on a closed port, which is the wrong order: a load balancer has to see
 * the probe fail while the port is still open.
 */
export class Readiness implements OnDrain {
  #reason: string | undefined;
  #draining = false;

  constructor(private readonly options: ReadinessOptions) {}

  /** `true` once shutdown has begun, or while something holds the pod out. */
  get draining(): boolean {
    return this.#draining || this.#reason !== undefined;
  }

  /** Why readiness is failing, for the report. */
  get reason(): string | undefined {
    return this.#draining ? (this.#reason ?? 'shutting down') : this.#reason;
  }

  /** Fail readiness until `release()`. Idempotent; the last reason wins. */
  hold(reason: string): void {
    this.#reason = reason;
  }

  release(): void {
    this.#reason = undefined;
  }

  /**
   * Fails readiness, then waits, all before the server stops accepting.
   *
   * The wait is here rather than in the application because this is the thing that
   * knows why it is waiting. `App.drain()` runs every hook under one `Promise.all`,
   * so this window overlaps a queue worker's own drain instead of being added to it.
   */
  async onDrain(): Promise<void> {
    this.#draining = true;
    if (this.options.drainDelayMs > 0) {
      await Bun.sleep(this.options.drainDelayMs);
    }
  }
}
