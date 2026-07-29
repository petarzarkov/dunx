import { type DynamicModule, provide } from '@dunx/core';
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
   * There is no `forRootAsync`. dunx resolves eagerly and awaits factories
   * before any constructor runs, so an asynchronously configured module is just
   * one whose options come from a factory — pass a function and it is awaited:
   *
   * ```ts
   * ImagesModule.forRoot(async () => ({ quality: await settings.quality() }));
   * ```
   *
   * `Images` is bound through an explicit factory rather than as a bare class so
   * that `@dunx/infra/images` works with or without the `@dunx/compiler` preload.
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
}
