import {
  Module,
  provide,
  type Deps,
  type DynamicModule,
  type AsyncModuleConfig,
  type Registration,
} from '@dunx/core';
import { Compression } from './compression.js';
import { CompressionOptions, type CompressionOptionsInit } from './options.js';

const middleware = (): Registration =>
  provide(Compression, {
    useFactory: (options: CompressionOptions) => new Compression(options),
    inject: [CompressionOptions] as const,
  });

/**
 * Binds `Compression` and its options. Like `StaticModule`, importing it does not
 * install anything - the app decides where in the chain it goes:
 *
 * ```ts
 * const app = await HttpFactory.create(AppModule, {
 *   imports: [CompressionModule.forRoot({ threshold: 2048 })],
 * });
 * app.use(Compression);
 * ```
 */
@Module({})
export class CompressionModule {
  static forRoot(init: CompressionOptionsInit = {}): DynamicModule {
    return {
      module: CompressionModule,
      exports: [CompressionOptions, Compression],
      providers: [
        provide(CompressionOptions, { useValue: new CompressionOptions(init) }),
        middleware(),
      ],
    };
  }

  /** `forRoot` with the options read off the container - a config value, usually. */
  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<CompressionOptionsInit, D>,
  ): DynamicModule {
    return {
      module: CompressionModule,
      ...(config.imports && { imports: config.imports }),
      exports: [CompressionOptions, Compression],
      providers: [
        provide(CompressionOptions, {
          useFactory: async (...deps: readonly unknown[]) =>
            new CompressionOptions(
              await (
                config.useFactory as (
                  ...args: readonly unknown[]
                ) => CompressionOptionsInit | Promise<CompressionOptionsInit>
              )(...deps),
            ),
          inject: config.inject ?? [],
        }),
        middleware(),
      ],
    };
  }
}
