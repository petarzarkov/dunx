import {
  type Deps,
  type DynamicModule,
  type AsyncModuleConfig,
  provide,
} from '@dunx/core';
import { Images } from './images.js';
import {
  type ImagesOptionsInput,
  ImagesOptions,
  withDefaults,
} from './options.js';

/** Options, or a loader for them. A loader may be async. */
export type ImagesConfig =
  | ImagesOptionsInput
  | (() => ImagesOptionsInput | Promise<ImagesOptionsInput>);

export class ImagesModule {
  /**
   * Bind {@link ImagesOptions} and {@link Images}.
   *
   * ```ts
   * @Module({ imports: [ImagesModule.forRoot({ quality: 90, maxWidth: 2048 })] })
   * export class AppModule {}
   * ```
   *
   * A function is awaited, so asynchronously loaded options need nothing extra:
   *
   * ```ts
   * ImagesModule.forRoot(async () => ({ quality: await settings.quality() }));
   * ```
   *
   * Use {@link ImagesModule.forRootAsync} when the options come from another
   * provider. `Images` is bound through an explicit factory so this module works
   * without the `@dunx/transform` preload.
   */
  static forRoot(config: ImagesConfig = {}): DynamicModule {
    return {
      module: ImagesModule,
      exports: [ImagesOptions, Images],
      providers: [
        provide(ImagesOptions, {
          useFactory: async () =>
            withDefaults(
              typeof config === 'function' ? await config() : config,
            ),
        }),
        provide(Images, {
          useFactory: (options: ImagesOptions) => new Images(options),
          inject: [ImagesOptions],
        }),
      ],
    };
  }

  /**
   * The same two bindings, with the options behind a factory that may inject:
   *
   * ```ts
   * ImagesModule.forRootAsync({
   *   useFactory: (config: ConfigService<AppConfig>) => ({
   *     quality: config.get('images').quality,
   *   }),
   *   inject: [ConfigService],
   * });
   * ```
   */
  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<ImagesOptionsInput, D>,
  ): DynamicModule {
    return {
      module: ImagesModule,
      ...(config.imports === undefined ? {} : { imports: config.imports }),
      exports: [ImagesOptions, Images],
      providers: [
        provide(ImagesOptions, {
          useFactory: async (...deps) =>
            withDefaults(await config.useFactory(...deps)),
          inject: config.inject ?? ([] as unknown as D),
        }),
        provide(Images, {
          useFactory: (options: ImagesOptions) => new Images(options),
          inject: [ImagesOptions],
        }),
      ],
    };
  }
}
