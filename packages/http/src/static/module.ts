import {
  Module,
  provide,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
  type Registration,
} from '@dunx/core';
import { StaticFiles } from './files.js';
import { StaticOptions, type StaticOptionsInit } from './options.js';

const files = (): Registration =>
  provide(StaticFiles, {
    useFactory: (options: StaticOptions) => new StaticFiles(options),
    inject: [StaticOptions] as const,
  });

/**
 * Serves a directory, the way Nest's `ServeStaticModule` does - and like the
 * dashboard, **it does not register itself**. The app does:
 *
 * ```ts
 * const app = await HttpFactory.create(AppModule);
 * app.use(StaticFiles);
 * ```
 *
 * Position in the chain is the decision being left to the app. Static assets
 * usually want to be *outside* an auth guard and *inside* request logging, and no
 * default can know which. Anything outside the mount falls through untouched, so
 * the app's own routes and its 404 behave exactly as before.
 *
 * There is no `index.html` fallback and no SPA rewrite. Both are one route in the
 * app - `@Get('/*')` returning `Bun.file(...)` - and building them in would mean
 * this middleware deciding what a 404 means for paths it does not own.
 */
@Module({})
export class StaticModule {
  static forRoot(init: StaticOptionsInit): DynamicModule {
    return {
      module: StaticModule,
      exports: [StaticOptions, StaticFiles],
      providers: [
        provide(StaticOptions, { useValue: new StaticOptions(init) }),
        files(),
      ],
    };
  }

  /** `forRoot` with the root read off the container - a config value, usually. */
  static forRootAsync<const D extends Deps>(
    config: FactoryProvider<StaticOptionsInit, D> & {
      readonly imports?: DynamicModule['imports'];
    },
  ): DynamicModule {
    return {
      module: StaticModule,
      ...(config.imports && { imports: config.imports }),
      exports: [StaticOptions, StaticFiles],
      providers: [
        provide(StaticOptions, {
          useFactory: async (...deps: readonly unknown[]) =>
            new StaticOptions(
              await (
                config.useFactory as (
                  ...args: readonly unknown[]
                ) => StaticOptionsInit | Promise<StaticOptionsInit>
              )(...deps),
            ),
          inject: config.inject ?? [],
        }),
        files(),
      ],
    };
  }
}
