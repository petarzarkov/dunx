import type { ShutdownSignal } from './app.js';

/**
 * How long a completed drain is given to let the process end on its own before it
 * is ended for it. Generous, because it is only ever spent on a process that would
 * otherwise never exit - see `ShutdownHooks`.
 */
const DEFAULT_EXIT_AFTER_MS = 1_000;

export interface ShutdownHookOptions {
  /**
   * Milliseconds to wait after the drain finishes before forcing the process to
   * exit, or `false` to leave it running.
   *
   * `false` is for an app embedded in a process it does not own, where exiting
   * would take someone else's work down with it. Anything that owns its process -
   * which is what registering a signal handler already implies - wants the default.
   */
  readonly exitAfterMs?: number | false;
}

/**
 * Signal handlers that guarantee the process actually **ends**, not merely that the
 * container drained.
 *
 * `process.once(signal, () => void shutdown())` was the whole implementation, in
 * three packages. It guarantees a drain and nothing else, so a single handle that
 * outlives teardown turns `SIGTERM` into "drain correctly, then hang until
 * `SIGKILL`". That is not hypothetical: bullmq's Bun adapter cannot cancel a pending
 * reconnect, so against an unreachable broker a client survives `disconnect()` and
 * holds the loop open after a completely successful shutdown
 * (docs/roadmap/queue-shutdown-sigterm.md). Every deployment then pays its full
 * termination grace period on every rollout.
 *
 * **The exit timer is `unref()`d, and that is the entire design.** An unref'd timer
 * cannot itself keep the runtime alive, so a process that would end on its own still
 * ends immediately and this never fires. It fires only when something else is
 * holding the loop open, which after a completed drain means a handle dunx does not
 * own. Verified on Bun 1.3.14: with nothing else pending the process exits in ~1 ms
 * and the callback never runs; with a live `Bun.serve` holding it, the callback runs
 * on schedule and `process.exit` takes effect (docs/bun-apis.md).
 *
 * The wait is therefore not a shutdown delay. It is the window in which work queued
 * after `app.closed` still gets to run, which is why it is not zero.
 *
 * **Only the signal path.** A programmatic `shutdown()` never exits the process: the
 * caller owns it, and a library that killed the process because a test called
 * `shutdown()` would be indefensible.
 */
export class ShutdownHooks {
  #installed = false;

  /**
   * Idempotent, and reports whether it did anything, because each app keeps its own
   * "already hooked" answer out of `enableShutdownHooks`.
   */
  install(
    drain: () => Promise<void>,
    signals: readonly ShutdownSignal[],
    options: ShutdownHookOptions = {},
  ): boolean {
    if (this.#installed) return false;
    this.#installed = true;

    const exitAfterMs = options.exitAfterMs ?? DEFAULT_EXIT_AFTER_MS;

    for (const signal of signals) {
      process.once(signal, () => {
        void drain().then(
          () => this.#armExit(exitAfterMs, 0),
          (error: unknown) => {
            // `console.error`, not the bound `Logger`: a logger is itself a provider
            // that has just been torn down, and this is the last thing the process
            // does. Reported rather than swallowed, and the exit is still armed -
            // a failed drain that then hangs is the worst of both.
            console.error('[dunx] shutdown failed', error);
            this.#armExit(exitAfterMs, 1);
          },
        );
      });
    }
    return true;
  }

  /**
   * **Never silent.** Reaching the timeout means the drain finished and something
   * outside the container is still holding the loop open, which is worth a line in
   * production - it names a leak that would otherwise show up only as pods taking
   * their full termination grace on every rollout.
   *
   * It also makes the one hostile case diagnosable. A test that fires a signal at
   * its own process arms this too, and an unannounced `process.exit(0)` mid-run
   * truncates the suite and reports success - which is exactly what it did to this
   * repo's own test run before this warning existed. Tests that exercise the signal
   * path pass `exitAfterMs: false`.
   */
  #armExit(afterMs: number | false, code: number): void {
    if (afterMs === false) return;
    setTimeout(() => {
      console.warn(
        `[dunx] the container drained but the process was still alive ${afterMs}ms ` +
          'later, so it is being exited. Something outside the container is holding ' +
          'the event loop open. In a test, pass enableShutdownHooks(signals, ' +
          '{ exitAfterMs: false }).',
      );
      process.exit(code);
    }, afterMs).unref();
  }
}
