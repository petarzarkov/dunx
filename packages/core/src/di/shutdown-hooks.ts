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
 * Signal handlers that guarantee the process ends, not merely that the container
 * drained. A bare `process.once(signal, shutdown)` guarantees the drain alone, so
 * one handle outliving teardown turns `SIGTERM` into a hang until `SIGKILL`.
 *
 * The exit timer is `unref()`d, so it never fires for a process that would end on
 * its own - only when something else holds the loop open. Signal path only: a
 * programmatic `shutdown()` never exits the process.
 */
export class ShutdownHooks {
  #installed = false;

  /**
   * Idempotent, and reports whether it did anything, because each app keeps its own
   * "already hooked" answer out of `enableShutdownHooks`.
   */
  install(
    /**
     * The whole teardown, not the `OnDrain` phase inside it. Named `drain` until
     * `OnDrain` arrived and made the word mean two things: that hook stops the
     * process taking new work while it is still serving, and this callback is
     * `shutdown()`, which runs it and then tears every provider down.
     */
    teardown: () => Promise<void>,
    signals: readonly ShutdownSignal[],
    options: ShutdownHookOptions = {},
  ): boolean {
    if (this.#installed) return false;
    this.#installed = true;

    const exitAfterMs = options.exitAfterMs ?? DEFAULT_EXIT_AFTER_MS;

    for (const signal of signals) {
      process.once(signal, () => {
        void teardown().then(
          () => this.#armExit(exitAfterMs, 0),
          (error: unknown) => {
            // `console.error`, not the bound `Logger`: a logger is itself a provider
            // that has just been torn down, and this is the last thing the process
            // does. Reported rather than swallowed, and the exit is still armed -
            // a failed teardown that then hangs is the worst of both.
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

/**
 * The half of an application class that is the same in every one of them: hold a
 * {@link ShutdownHooks}, and install it against this object's own `shutdown()`.
 *
 * `@dunx/core`, `@dunx/http` and `@dunx/infra` each own an application class, and
 * each used to carry an identical copy of the installer. Three copies of "drain,
 * then make sure the process actually ends" is three chances to fix a hang in one
 * and not the others, which is how it was missed the first time.
 *
 * `shutdown` is abstract rather than assumed, so a subclass that does not have one
 * is a compile error rather than a handler installed against `undefined`.
 */
export abstract class ShutdownAware {
  readonly #hooks = new ShutdownHooks();

  abstract shutdown(): Promise<void>;

  enableShutdownHooks(
    signals: readonly ShutdownSignal[] = ['SIGTERM', 'SIGINT'],
    options: ShutdownHookOptions = {},
  ): this {
    this.#hooks.install(() => this.shutdown(), signals, options);
    return this;
  }
}
