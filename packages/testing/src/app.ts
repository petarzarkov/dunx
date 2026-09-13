import {
  AppFactory,
  provide,
  type App,
  type AppOptions,
  type DynamicModule,
  type ModuleRef,
  type Registration,
} from '@dunx/core';
import { ReadinessOptions } from '@dunx/http';

/**
 * The synthetic root. A named class rather than an object literal for the same
 * reason `@dunx/http`'s `HttpModule` is one: it is what a duplicate-binding error
 * would name if the harness itself ever bound anything.
 */
class TestModule {}

export interface TestAppOptions extends AppOptions {
  /**
   * The graph under test. A single module, or several - they become the `imports`
   * of one synthetic root, so no fixture module has to be written by hand.
   */
  readonly modules: ModuleRef | readonly ModuleRef[];
}

const isList = (
  modules: ModuleRef | readonly ModuleRef[],
): modules is readonly ModuleRef[] => Array.isArray(modules);

/**
 * The root `createTestApp` boots. Exported for the case the harness deliberately
 * does not cover: configuring an `HttpApp` before `listen()` (`enableCors`, `use`,
 * `set`), which means calling `HttpFactory.create(testRoot(modules), …)` directly.
 */
export const testRoot = (
  modules: ModuleRef | readonly ModuleRef[],
): DynamicModule => ({
  module: TestModule,
  imports: isList(modules) ? modules : [modules],
});

/**
 * `HealthModule`'s shutdown drain, zeroed: a suite has no load balancer to notice
 * a failing probe, and at the five seconds a deployment wants it exceeds Bun's
 * default hook timeout once per file.
 *
 * First in the list, so a suite testing the drain passes its own and wins. Safe
 * with no `HealthModule` in the graph: an override for a class nobody bound is
 * registered lazily and never built.
 */
const NO_DRAIN = provide(ReadinessOptions, {
  useValue: new ReadinessOptions({ drainDelayMs: 0 }),
});

/** The caller's overrides, behind the harness's own. */
export const appOptions = (
  overrides: readonly Registration[] | undefined,
): AppOptions => ({ overrides: [NO_DRAIN, ...(overrides ?? [])] });

/**
 * The container the app under test would have, with the bindings named in
 * `overrides` **replaced in place**.
 *
 * ```ts
 * const app = await createTestApp({
 *   modules: [UsersModule],
 *   overrides: [provide(Clock, { useValue: new FixedClock('2026-01-01') })],
 * });
 * ```
 *
 * Replacement, not addition: the discarded provider is never instantiated, so an
 * async `useFactory` that would open the real database never runs. An override
 * naming a token nobody binds throws instead of passing silently.
 *
 * One binding is replaced without being asked for: `ReadinessOptions`, so
 * `HealthModule`'s shutdown drain does not run per teardown. Pass your own to
 * restore it.
 */
export const createTestApp = (options: TestAppOptions): Promise<App> =>
  AppFactory.create(testRoot(options.modules), appOptions(options.overrides));
