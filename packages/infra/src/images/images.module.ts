import {
  type Deps,
  type DynamicModule,
  type FactoryProvider,
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
   * Use {@link ImagesModule.forRootAsync} when the options have to come from
   * another provider - that is the one thing a zero-argument function cannot do.
   *
   * `Images` is bound through an explicit factory rather than as a bare class so
   * that `@dunx/infra/images` works with or without the `@dunx/transform` preload.
   * Consumers still need the preload for *their own* classes to inject `Images`
   * by constructor.
   */
  static forRoot(config: ImagesConfig = {}): DynamicModule {
    return {
      module: ImagesModule,
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
   * The same two bindings, with the options produced by a factory that may
   * inject - reading the quality off `ConfigService`, say:
   *
   * ```ts
   * ImagesModule.forRootAsync({
   *   useFactory: (config: ConfigService<AppConfig>) => ({
   *     quality: config.get('images').quality,
   *   }),
   *   inject: [ConfigService],
   * });
   * ```
   *
   * Named for the `FilesModule`/`DbModule` precedent, not because asynchrony is
   * the point: `forRoot` already awaits a function.
   */
  static forRootAsync<const D extends Deps>(
    config: FactoryProvider<ImagesOptionsInput, D>,
  ): DynamicModule {
    return {
      module: ImagesModule,
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
