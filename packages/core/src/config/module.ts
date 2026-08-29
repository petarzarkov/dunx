import type { DynamicModule } from '../di/module.js';
import { provide } from '../di/provider.js';
import { token } from '../di/token.js';
import { issuePath, type StandardSchemaV1 } from './schema.js';
import { ConfigError, ConfigService, type ConfigSource } from './service.js';

/** The raw source `validate` was handed, bound so a factory can read it. */
export const ConfigInput = token<ConfigSource>('ConfigInput');

interface ConfigModuleBase<T extends object> {
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
   * Without it, `inject: [ConfigService]` resolves to
   * `ConfigService<Record<string, unknown>>` and a factory declaring
   * `ConfigService<AppConfig>` is rejected: parameters are contravariant and the
   * token carries no type argument. `ConfigService` stays bound to the same
   * instance, so either injects.
   */
  readonly as?: new (values: T) => ConfigService<T>;
}

/**
 * How the raw source becomes typed configuration: a function, or a schema.
 * Exactly one, because two would leave it unclear which ran.
 */
export type ConfigModuleOptions<T extends object> = ConfigModuleBase<T> &
  (
    | {
        /**
         * The one validation step. It receives the raw source and returns the
         * shaped, typed configuration; whatever it throws is what boot fails
         * with, so use an error whose message says which keys are wrong.
         *
         * A hand-written function costs no dependency and works identically to
         * a schema.
         */
        readonly validate: (env: ConfigSource) => T | Promise<T>;
        readonly schema?: undefined;
      }
    | {
        /**
         * A Standard Schema, validated directly. Zod 4, Valibot and ArkType all
         * satisfy it, and dunx picks none of them:
         *
         * ```ts
         * ConfigModule.forRoot({ schema: envSchema, as: AppConfigService });
         * ```
         *
         * The same thing as `validate: (env) => envSchema.parse(env)`, without
         * the wrapper and without naming a vendor's parse method. A failure
         * becomes a `ConfigError` listing every issue with its path, rather than
         * whatever shape the library throws.
         */
        readonly schema: StandardSchemaV1<unknown, T>;
        readonly validate?: undefined;
      }
  );

/**
 * One validation function out of either spelling, so the rest of the module has
 * a single path.
 */
const validatorFor = <T extends object>(
  options: ConfigModuleOptions<T>,
): ((env: ConfigSource) => T | Promise<T>) => {
  if (options.validate !== undefined) return options.validate;

  const { schema } = options;
  return async (env: ConfigSource): Promise<T> => {
    const result = await schema['~standard'].validate(env);
    if (result.issues === undefined) return result.value;

    // Every issue, with its path, in one message. A schema library's own error
    // is a different shape per vendor, and boot failing is not the place to
    // learn which one is installed.
    const detail = result.issues
      .map((issue) => {
        const path = issuePath(issue);
        return path === '' ? issue.message : `${path}: ${issue.message}`;
      })
      .join('; ');
    throw new ConfigError(`Configuration is invalid. ${detail}`);
  };
};

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
    const validate = validatorFor(options);
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
            new Target(await validate(env)),
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
