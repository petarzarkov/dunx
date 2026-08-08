import {
  Logger,
  Module,
  provide,
  ROOT_MODULE,
  type AsyncModuleConfig,
  type Deps,
  type DynamicModule,
  type ModuleRef,
  type Registration,
} from '@dunx/core';
import { DashboardMiddleware } from './middleware.js';
import { DashboardOptions, type DashboardOptionsInit } from './options.js';

/**
 * `useFactory` rather than listing the class bare, which would work too - it just
 * makes the binding explicit and independent of `@dunx/transform`, the same choice
 * `RedisModule` makes for `Redis`. It matters slightly more here: this package's
 * own test suite runs from `src` with no compiler preload, like every other
 * package's.
 *
 * `ROOT_MODULE` is core's, bound into the global scope by `AppFactory.create`. It
 * is how the middleware names the graph it reports on - the readers all take a
 * `ModuleRef`, and asking the app to pass its own root module into its own
 * `imports` would be a circular reference to write out by hand.
 */
const middleware = (): Registration =>
  provide(DashboardMiddleware, {
    useFactory: (options: DashboardOptions, root: ModuleRef, logger: Logger) =>
      new DashboardMiddleware(options, root, logger),
    inject: [DashboardOptions, ROOT_MODULE, Logger] as const,
  });

/**
 * Binds the options and the middleware. **It does not register the middleware** -
 * the app does, with `app.use(DashboardMiddleware)`, and that is deliberate:
 * position in the chain is the whole security property here.
 *
 * `@Module({ middleware })` scopes middleware to that module's own controllers, of
 * which this module has none, so it would never run. Registering globally from
 * inside the module would put it wherever the module happened to be imported, and
 * it has to be **ahead of any session guard** - measured in `dunx-template`, where a
 * guard running first answered every dashboard request `401` before `authorize`
 * ran, defeating the 404 contract. Two lines in the app, one of which is a
 * decision:
 *
 * ```ts
 * const app = await HttpFactory.create(AppModule);
 * app.use(DashboardMiddleware, SessionGuard);
 * ```
 */
@Module({})
export class DashboardModule {
  static forRoot(init: DashboardOptionsInit = {}): DynamicModule {
    return {
      module: DashboardModule,
      exports: [DashboardOptions, DashboardMiddleware],
      providers: [
        provide(DashboardOptions, { useValue: new DashboardOptions(init) }),
        middleware(),
      ],
    };
  }

  /**
   * `forRoot` with the options behind a factory - which is the **normal** way to
   * mount this, not the exotic one: `queues` wants `JobPublisher` and `redis` wants
   * `RedisConnection`, and both come out of the container.
   *
   * ```ts
   * DashboardModule.forRootAsync({
   *   useFactory: (queues: JobPublisher, redis: RedisConnection) => ({
   *     queues,
   *     redis,
   *     authorize: (req) => req.headers.get('x-admin-key') === process.env.ADMIN,
   *   }),
   *   inject: [JobPublisher, RedisConnection],
   * });
   * ```
   *
   * There is no separate async machinery: the container resolves eagerly and awaits
   * factories before any constructor runs.
   */
  static forRootAsync(
    load: () => DashboardOptionsInit | Promise<DashboardOptionsInit>,
  ): DynamicModule;
  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<DashboardOptionsInit, D>,
  ): DynamicModule;
  static forRootAsync(
    source:
      | (() => DashboardOptionsInit | Promise<DashboardOptionsInit>)
      | AsyncModuleConfig<DashboardOptionsInit, Deps>,
  ): DynamicModule {
    const load = typeof source === 'function' ? source : source.useFactory;
    const inject = typeof source === 'function' ? [] : (source.inject ?? []);
    // The container is scoped: this dynamic module is its own scope, so a factory
    // injecting `JobPublisher` needs the module that exports it in *these*
    // imports. Importing it into whatever module calls `forRootAsync` does not
    // reach here - that is a boot error naming both modules, clear but only once.
    // Forwarding is what makes the documented wiring work.
    const imports = typeof source === 'function' ? [] : (source.imports ?? []);

    return {
      module: DashboardModule,
      imports,
      exports: [DashboardOptions, DashboardMiddleware],
      providers: [
        provide(DashboardOptions, {
          useFactory: async (...deps: readonly unknown[]) =>
            new DashboardOptions(await load(...deps)),
          inject,
        }),
        middleware(),
      ],
    };
  }
}
