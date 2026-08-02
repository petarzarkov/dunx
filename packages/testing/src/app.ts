import {
  AppFactory,
  type App,
  type AppOptions,
  type DynamicModule,
  type ModuleRef,
  type Registration,
} from '@dunx/core';

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

/** `exactOptionalPropertyTypes` separates an absent key from an undefined one. */
export const appOptions = (
  overrides: readonly Registration[] | undefined,
): AppOptions => (overrides ? { overrides } : {});

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
 */
export const createTestApp = (options: TestAppOptions): Promise<App> =>
  AppFactory.create(testRoot(options.modules), appOptions(options.overrides));
