import { AppError } from '../di/errors.js';

/** Raw key/value pairs handed to `validate`. `Bun.env`'s shape. */
export type ConfigSource = Record<string, string | undefined>;

export class ConfigError extends AppError {
  override name = 'ConfigError';
}

/**
 * The validated configuration, injectable.
 *
 * Parameterise it at the injection site - the transform records the bare name of
 * a generic annotation, so the type argument costs nothing at runtime:
 *
 * ```ts
 * class Users {
 *   constructor(private readonly config: ConfigService<AppConfig>) {}
 * }
 * ```
 *
 * `AppConfig` is whatever the `validate` function returns; nothing declares it
 * twice. A type alias will **not** work in that position - the transform needs a
 * runtime value to record, and an alias erases.
 */
export class ConfigService<T extends object = Record<string, unknown>> {
  /**
   * The whole validated object, for destructuring or passing on. `get` exists for
   * the single-key case; there is no dotted-path lookup, because the object is
   * fully typed and `config.values.db.host` already reads better than a string.
   */
  readonly values: T;

  constructor(values: T) {
    this.values = values;
  }

  get<K extends keyof T>(key: K): T[K] {
    return this.values[key];
  }

  /**
   * Named for the NestJS method it replaces. Guards the value being present, not
   * the key being declared - a missing key is already a type error.
   */
  getOrThrow<K extends keyof T>(key: K): NonNullable<T[K]> {
    const value = this.values[key];
    if (value === undefined || value === null) {
      throw new ConfigError(`Config key "${String(key)}" is not set`);
    }
    return value as NonNullable<T[K]>;
  }
}
