import {
  Module,
  provide,
  type AsyncModuleConfig,
  type Deps,
  type DynamicModule,
  type ModuleRef,
  type Registration,
} from '@dunx/core';
import { ConnectMiddleware } from './middleware.js';
import {
  ConnectOptions,
  type ConnectOptionsInit,
  type ConnectServiceRegistration,
} from './options.js';
import { ConnectRegistry } from './registry.js';

/** Everything `forRoot` takes except the services, which `forRootAsync` needs
 * synchronously, and `imports`, which `AsyncModuleConfig` already carries. */
export type ConnectSettings = Omit<ConnectOptionsInit, 'services' | 'imports'>;

const build = (
  services: readonly ConnectServiceRegistration[],
  options: Registration,
  imports: readonly ModuleRef[],
): DynamicModule => {
  const implementations = services.map((registration) => registration.useClass);

  return {
    module: ConnectModule,
    imports,
    exports: [ConnectOptions, ConnectRegistry, ConnectMiddleware],
    providers: [
      // Providers of this module, so their constructors are injected.
      ...implementations,
      options,
      // Every binding declares its own `inject`, so none of this needs
      // `@dunx/transform` to have run.
      provide(ConnectRegistry, {
        useFactory: (...deps: readonly unknown[]) => {
          const [resolved, ...instances] = deps;
          return new ConnectRegistry(
            resolved as ConnectOptions,
            instances as readonly object[],
          );
        },
        inject: [ConnectOptions, ...implementations],
      }),
      provide(ConnectMiddleware, {
        useFactory: (registry: ConnectRegistry) =>
          new ConnectMiddleware(registry),
        inject: [ConnectRegistry] as const,
      }),
    ],
  };
};

/**
 * Serves protobuf services over Connect and gRPC-Web on the port `Bun.serve`
 * already has. See `docs/guide/27-rpc.md`.
 *
 * ```ts
 * ConnectModule.forRoot({
 *   services: [connectService(GreetService, GreetRpc)],
 *   // What GreetRpc injects: this module is its own scope.
 *   imports: [GreetingsModule],
 * });
 * ```
 *
 * It binds `ConnectMiddleware` and does not register it - position in the chain
 * decides which guards cover an RPC, so the app calls `app.use`.
 */
@Module({})
export class ConnectModule {
  static forRoot(init: ConnectOptionsInit): DynamicModule {
    return build(
      init.services,
      provide(ConnectOptions, { useValue: new ConnectOptions(init) }),
      init.imports ?? [],
    );
  }

  /**
   * `forRoot` with everything but the services behind a factory, so the prefix
   * or the read limits can come off `ConfigService`. The services are positional
   * because their classes have to be providers before any factory runs.
   */
  static forRootAsync<const D extends Deps>(
    services: readonly ConnectServiceRegistration[],
    config: AsyncModuleConfig<ConnectSettings, D>,
  ): DynamicModule;
  static forRootAsync(
    services: readonly ConnectServiceRegistration[],
    config: AsyncModuleConfig<ConnectSettings, Deps>,
  ): DynamicModule {
    return build(
      services,
      provide(ConnectOptions, {
        useFactory: async (...deps: readonly unknown[]) =>
          new ConnectOptions({
            ...(await config.useFactory(...deps)),
            services,
          }),
        inject: config.inject ?? [],
      }),
      // This dynamic module is its own scope, so a factory injecting a provider
      // needs the module that exports it in *these* imports.
      config.imports ?? [],
    );
  }
}
