import type { Logger } from '@dunx/core';

import { ScheduleError, ScheduleErrorCode } from './errors.js';
import { Overlap, ScheduleKind, type ScheduleMeta } from './marker.js';
import { assertZoneUsable, type ScheduleOptions } from './options.js';

interface Armed {
  readonly entry: ScheduleEntry;
  readonly run: () => unknown;
  cron?: Bun.CronJob | undefined;
  timer?: ReturnType<typeof setInterval> | undefined;
}

/**
 * One schedule's identity and its running state.
 *
 * A class rather than an interface so the container and a dashboard have a runtime
 * value. Fields are mutable because they are a live view: `list()` hands back the
 * same objects the runner is updating.
 */
export class ScheduleEntry {
  running = false;
  runs = 0;
  lastError: Error | undefined;
  lastRunAt: Date | undefined;
  /** For a cron, the next fire `Bun.cron.parse` computes. Absent for a timer. */
  nextRunAt: Date | undefined;
  /** Set once an `@OnceOnBoot` has fired, or a schedule has been disarmed. */
  finished = false;

  constructor(
    readonly name: string,
    readonly kind: ScheduleKind,
    readonly at: string | number,
    readonly overlap: Overlap,
    readonly tz: string | undefined,
  ) {}
}

/**
 * Every armed schedule, and the only way to add or remove one at runtime.
 *
 * It earns its place the way `@nestjs/schedule`'s `SchedulerRegistry` does: a
 * feature flag or a per-tenant schedule has nowhere else to live, and without it a
 * schedule changes only by redeploying. `trigger` also makes a schedule testable
 * without waiting for a minute boundary, which is `Bun.cron`'s resolution.
 */
export class ScheduleRegistry {
  readonly #armed = new Map<string, Armed>();

  constructor(
    private readonly options: ScheduleOptions,
    private readonly logger: Logger,
  ) {}

  /**
   * Arms a schedule. The name defaults to the caller's, and a repeat is a boot
   * error: two schedules under one name would leave `remove` and `trigger` picking
   * whichever was registered second.
   */
  add(
    meta: ScheduleMeta,
    handler: () => unknown,
    fallbackName?: string,
  ): ScheduleEntry {
    const name = meta.name ?? fallbackName;
    if (!name) {
      throw new ScheduleError(
        ScheduleErrorCode.INVALID_SCHEDULE,
        'A schedule needs a name. Pass one in the decorator options, or add it ' +
          'through the runner, which derives ClassName.methodName.',
      );
    }
    if (this.#armed.has(name)) {
      throw new ScheduleError(
        ScheduleErrorCode.DUPLICATE_SCHEDULE,
        `Two schedules claim the name "${name}". One name, one schedule.`,
      );
    }

    const tz =
      meta.kind === ScheduleKind.CRON
        ? assertZoneUsable(meta.tz ?? this.options.tz, `schedule "${name}"`)
        : undefined;

    const entry = new ScheduleEntry(
      name,
      meta.kind,
      meta.at,
      meta.overlap ?? this.options.overlap,
      tz,
    );
    const armed: Armed = { entry, run: handler };
    this.#armed.set(name, armed);

    if (meta.enabled ?? true) this.#arm(armed);
    return entry;
  }

  /** Stops and forgets a schedule. `false` if the registry never held it. */
  remove(name: string): boolean {
    const armed = this.#armed.get(name);
    if (!armed) return false;
    this.#disarm(armed);
    this.#armed.delete(name);
    return true;
  }

  list(): readonly ScheduleEntry[] {
    return [...this.#armed.values()].map((armed) => armed.entry);
  }

  get(name: string): ScheduleEntry | undefined {
    return this.#armed.get(name)?.entry;
  }

  /**
   * Runs a schedule now, off its own cadence, honouring `overlap`. What a test uses
   * instead of waiting a minute, and what an operator uses to force a nightly job.
   */
  async trigger(name: string): Promise<unknown> {
    const armed = this.#armed.get(name);
    if (!armed) {
      throw new ScheduleError(
        ScheduleErrorCode.UNKNOWN_SCHEDULE,
        `No schedule named "${name}". Held: ${[...this.#armed.keys()].join(', ') || 'none'}.`,
      );
    }
    return this.#invoke(armed, 'trigger');
  }

  /** Stops every handle. Called by the runner on shutdown. */
  stopAll(): void {
    for (const armed of this.#armed.values()) this.#disarm(armed);
  }

  /** In-flight runs, so shutdown can wait for them. */
  get inFlight(): readonly string[] {
    return [...this.#armed.values()]
      .filter((armed) => armed.entry.running)
      .map((armed) => armed.entry.name);
  }

  #arm(armed: Armed): void {
    const { entry } = armed;
    if (entry.kind === ScheduleKind.CRON) {
      const handle = Bun.cron(
        entry.at as Bun.CronWithAutocomplete,
        () => {
          const promise = this.#invoke(armed, 'cron');
          // Returned only under SKIP, which is what makes Bun compute the next
          // fire once this settles. Under CONCURRENT it must not see a promise.
          return entry.overlap === Overlap.SKIP ? promise : undefined;
        },
        // Always explicit. 1.3.x ignores it and is already UTC; 1.4 honours it and
        // pins the zone rather than drifting to the container's TZ.
        { tz: entry.tz ?? 'UTC' },
      );
      if (!this.options.keepAlive) handle.unref();
      armed.cron = handle;
      entry.nextRunAt = this.#nextFire(entry);
      return;
    }

    const ms = entry.at as number;
    const timer =
      entry.kind === ScheduleKind.INTERVAL
        ? setInterval(() => void this.#invoke(armed, 'interval'), ms)
        : setTimeout(() => {
            entry.finished = true;
            void this.#invoke(armed, 'timeout');
          }, ms);
    if (!this.options.keepAlive) {
      (timer as unknown as { unref?: () => void }).unref?.();
    }
    armed.timer = timer;
  }

  #disarm(armed: Armed): void {
    armed.cron?.stop();
    armed.cron = undefined;
    if (armed.timer) {
      clearInterval(armed.timer);
      armed.timer = undefined;
    }
    armed.entry.finished = true;
    armed.entry.nextRunAt = undefined;
  }

  #nextFire(entry: ScheduleEntry): Date | undefined {
    if (entry.kind !== ScheduleKind.CRON) return undefined;
    try {
      return (
        Bun.cron.parse(entry.at as Bun.CronWithAutocomplete, new Date(), {
          tz: entry.tz ?? 'UTC',
        }) ?? undefined
      );
    } catch {
      return undefined;
    }
  }

  /**
   * One run, with the overlap policy applied.
   *
   * The promise is always handed back, and the cron arm site decides whether
   * `Bun.cron` sees it: returning it is what gives Bun its own overlap guarantee,
   * since it computes the next fire only once the handler settles. Returning it
   * from here unconditionally is what lets `trigger` be awaited under either
   * policy. The `running` guard is what stops a timer, which has no such courtesy,
   * from stacking runs. `undefined` means the run was skipped.
   */
  #invoke(armed: Armed, source: string): Promise<unknown> | undefined {
    const { entry } = armed;
    if (entry.running && entry.overlap === Overlap.SKIP) {
      const elapsed = entry.lastRunAt
        ? Date.now() - entry.lastRunAt.getTime()
        : 0;
      this.logger.warn(`Schedule "${entry.name}" skipped: still running`, {
        schedule: entry.name,
        source,
        elapsedMs: elapsed,
      });
      return undefined;
    }

    entry.running = true;
    entry.runs += 1;
    entry.lastRunAt = new Date();
    entry.nextRunAt = this.#nextFire(entry);

    const settle = (error?: unknown): void => {
      entry.running = false;
      entry.lastError =
        error === undefined
          ? undefined
          : error instanceof Error
            ? error
            : new Error(String(error));
      if (error !== undefined) {
        // Reported, never rethrown: a throwing handler must not take down the
        // timer or leave `Bun.cron` with a rejected promise it will not schedule
        // past.
        this.logger.error(`Schedule "${entry.name}" failed`, {
          schedule: entry.name,
          source,
          error: entry.lastError,
        });
      }
    };

    let result: unknown;
    try {
      result = armed.run();
    } catch (error) {
      settle(error);
      return undefined;
    }

    const promise = Promise.resolve(result).then(
      (value) => {
        settle();
        return value;
      },
      (error: unknown) => {
        settle(error);
        return undefined;
      },
    );

    return promise;
  }
}
