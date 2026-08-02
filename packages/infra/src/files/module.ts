import {
  provide,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
} from '@dunx/core';
import { Storage, StorageOptions } from './storage.js';

/**
 * Bound identically by both factories. The backend is whichever `StorageOptions`
 * subclass got configured, so the module never branches on one - and
 * `forRootAsync` really is `forRoot` with a factory in front of it.
 */
const storage = provide(Storage, {
  useFactory: (options: StorageOptions) => options.create(),
  inject: [StorageOptions],
});

/**
 * Binds `Storage` and the `StorageOptions` that selected it.
 *
 * ```ts
 * @Module({ imports: [FilesModule.forRoot(new LocalStorageOptions('/var/data'))] })
 * class AppModule {}
 * ```
 */
export class FilesModule {
  static forRoot(options: StorageOptions): DynamicModule {
    return {
      module: FilesModule,
      providers: [provide(StorageOptions, { useValue: options }), storage],
    };
  }

  /**
   * The same two bindings, with the options produced by a factory that may await
   * and may itself inject. dunx resolves eagerly and settles async factories
   * before any constructor runs, so no extra mechanism is needed.
   *
   * ```ts
   * FilesModule.forRootAsync({
   *   useFactory: (config: AppConfig) => new LocalStorageOptions(config.dataDir),
   *   inject: [AppConfig],
   * });
   * ```
   */
  static forRootAsync<const D extends Deps>(
    options: FactoryProvider<StorageOptions, D>,
  ): DynamicModule {
    return {
      module: FilesModule,
      providers: [provide(StorageOptions, options), storage],
    };
  }
}
