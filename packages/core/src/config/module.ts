import type { DynamicModule } from '../di/module.js';
import { provide } from '../di/provider.js';
import { token } from '../di/token.js';
import { ConfigService, type ConfigSource } from './service.js';

/** The raw source `validate` was handed, bound so a factory can read it. */
export const ConfigInput = token<ConfigSource>('ConfigInput');

export interface ConfigModuleOptions<T extends object> {
  /**
   * The one validation step. It receives the raw source and returns the shaped,
   * typed configuration; whatever it throws is what boot fails with, so use an
   * error whose message says which keys are wrong.
   *
   * dunx does not pick the library. With zod that is
   * `validate: (env) => envSchema.parse(env)`; a hand-written function that
   * throws works identically.
   */
  readonly validate: (env: ConfigSource) => T | Promise<T>;
  /**
   * Defaults to `Bun.env`, which already carries `.env` and `.env.local` -
   * Bun loads them itself, so there is no loader here and no `dotenv`.
   *
   * Pass a plain object in a test rather than mutating the process environment.
   */
  readonly source?: ConfigSource;
  /**
   * Bind under a subclass as well, so the type argument survives into places
   * that name the token rather than annotate a parameter:
   *
   * ```ts
   * export class AppConfigService extends ConfigService<AppConfig> {}
   *
   * ConfigModule.forRoot({ validate, as: AppConfigService });
   * ```
   *
   * Without this, `inject: [ConfigService]` resolves to
   * `ConfigService<Record<string, unknown>>` and a factory declaring
   * `ConfigService<AppConfig>` is rejected - parameters are contravariant, and
   * the token carries no type argument to recover. A subclass is a distinct
   * runtime value, so it is both a precise token and a usable annotation.
   *
   * `ConfigService` stays bound to the same instance, so either injects.
   */
  readonly as?: new (values: T) => ConfigService<T>;
}

export class ConfigModule {
  /**
   * Validates once at boot and binds the result to `ConfigService`.
   *
   * **`global: true`**, because configuration is the one thing every module reads and
   * making each of them import a config module would be ceremony with no boundary
   * worth enforcing. That is also why there is no `isGlobal` option: it is not a
   * choice. `ConfigInput` stays private - it is the raw environment, and nothing
   * outside this module should read it.
   *
   * There is no `forRootAsync`: eager resolution settles an async `validate` before
   * any constructor runs.
   */
  static forRoot<T extends object>(
    options: ConfigModuleOptions<T>,
  ): DynamicModule {
    const Target = options.as ?? ConfigService;
    return {
      module: ConfigModule,
      global: true,
      exports:
        options.as === undefined
          ? [ConfigService]
          : [ConfigService, options.as],
      providers: [
        provide(ConfigInput, { useValue: options.source ?? Bun.env }),
        provide(Target, {
          useFactory: async (env: ConfigSource) =>
            new Target(await options.validate(env)),
          inject: [ConfigInput] as const,
        }),
        // Alias, not a second instance: an app that subclasses can still be
        // injected by the base contract, and library code only knows that one.
        ...(options.as === undefined
          ? []
          : [
              provide(ConfigService, {
                useFactory: (config: ConfigService<T>) => config,
                inject: [options.as] as const,
              }),
            ]),
      ],
    };
  }
}
