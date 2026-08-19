import {
  AppRef,
  classOf,
  collectModules,
  Logger,
  markedMethods,
  readControllers,
  ROOT_MODULE,
  type Ctor,
  type InjectionToken,
  type ModuleRef,
  type OnInit,
  type OnShutdown,
} from '@dunx/core';
import { scheduleMetaOf, type ScheduleMeta } from './marker.js';
import { ScheduleOptions } from './options.js';
import { ScheduleRegistry } from './registry.js';

/** How long shutdown waits for a run that is already going. */
const DRAIN_TIMEOUT_MS = 5_000;
const DRAIN_POLL_MS = 25;

interface Found {
  readonly provider: string;
  readonly method: string;
  readonly meta: ScheduleMeta;
  readonly handler: () => unknown;
}

const schedulesOn = (instance: object): readonly Found[] => {
  const provider = instance.constructor.name;
  const members = instance as Record<string, () => unknown>;

  return markedMethods(
    Object.getPrototypeOf(instance) as object | null,
    scheduleMetaOf,
  ).map(({ name, meta }) => ({
    provider,
    method: name,
    meta,
    handler: members[name]!.bind(instance),
  }));
};

const declaresSchedule = (ctor: Ctor<unknown>): boolean =>
  markedMethods(ctor.prototype as object | null, scheduleMetaOf).length > 0;

/**
 * Finds every `@Cron`, `@Interval` and `@OnceOnBoot` in the graph and arms it.
 *
 * `AppRef` rather than constructor injection for the handlers: which classes declare
 * a schedule is not knowable when this is built, so the tokens cannot be named in an
 * `inject` list. It is read in `onInit`, the only point at which that is legal.
 *
 * A schedule is declared in `@Module({ providers })` - or on a controller - like any
 * other injectable, and found here by its marker, so a handler needs no second
 * registration and an abstract base's marked methods are inherited by every
 * subclass. Same discovery-by-inspection routes, gateways and job handlers get.
 */
export class ScheduleRunner implements OnInit, OnShutdown {
  readonly #ref: AppRef;
  readonly #root: ModuleRef;
  readonly #options: ScheduleOptions;
  readonly #registry: ScheduleRegistry;
  readonly #logger: Logger;

  constructor(
    ref: AppRef,
    root: ModuleRef,
    options: ScheduleOptions,
    registry: ScheduleRegistry,
    logger: Logger,
  ) {
    this.#ref = ref;
    this.#root = root;
    this.#options = options;
    this.#registry = registry;
    this.#logger = logger;
  }

  onInit(): void {
    // The gate is here rather than in the module: `forRootAsync` builds its options
    // from a factory, so `enabled` is not knowable when providers are declared.
    if (!this.#options.enabled) {
      this.#logger.info('Schedules discovered but not armed (enabled: false)');
      return;
    }

    const app = this.#ref.current;
    const scanned = new Set<Ctor<unknown>>();
    const found: Found[] = [];

    const scan = (
      token: InjectionToken<unknown>,
      ctor: Ctor<unknown>,
    ): void => {
      if (scanned.has(ctor) || !declaresSchedule(ctor)) return;
      scanned.add(ctor);
      found.push(...schedulesOn(app.get(token) as object));
    };

    for (const module of collectModules(this.#root)) {
      for (const entry of module.options.providers ?? []) {
        const candidate = classOf(entry);
        if (candidate) scan(candidate.token, candidate.ctor);
      }
      for (const controller of readControllers(module)) {
        scan(controller, controller);
      }
    }

    if (found.length === 0) return;

    for (const { provider, method, meta, handler } of found) {
      this.#registry.add(meta, handler, `${provider}.${method}`);
    }

    // One entry naming everything armed, which is how "is my schedule registered"
    // gets answered from production rather than by reading the source.
    this.#logger.info(`Scheduled ${found.length} handler(s)`, {
      schedules: this.#registry.list().map((entry) => ({
        name: entry.name,
        kind: entry.kind,
        at: entry.at,
        ...(entry.tz === undefined ? {} : { tz: entry.tz }),
        ...(entry.nextRunAt === undefined
          ? {}
          : { nextRunAt: entry.nextRunAt.toISOString() }),
      })),
    });
  }

  /**
   * Stops every handle first, so nothing new starts, then waits out what is already
   * running. Bounded: a handler that never returns must not hold shutdown open
   * forever, and the entry it belongs to is named in the warning so the culprit is
   * not a guess.
   */
  async onShutdown(): Promise<void> {
    this.#registry.stopAll();

    const deadline = Date.now() + DRAIN_TIMEOUT_MS;
    while (this.#registry.inFlight.length > 0 && Date.now() < deadline) {
      await Bun.sleep(DRAIN_POLL_MS);
    }

    const stuck = this.#registry.inFlight;
    if (stuck.length > 0) {
      this.#logger.warn(
        `Shutting down with ${stuck.length} schedule(s) still running after ` +
          `${DRAIN_TIMEOUT_MS} ms`,
        { schedules: stuck },
      );
    }
  }
}

/** The tokens the runner needs, in constructor order. */
export const SCHEDULE_RUNNER_DEPS = [
  AppRef,
  ROOT_MODULE,
  ScheduleOptions,
  ScheduleRegistry,
  Logger,
] as const;
