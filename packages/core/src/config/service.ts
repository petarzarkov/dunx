import { AppError } from '../di/errors.js';

/** Raw key/value pairs handed to `validate`. `Bun.env`'s shape. */
export type ConfigSource = Record<string, string | undefined>;

export class ConfigError extends AppError {
  override name = 'ConfigError';
}

/**
 * `undefined` when `V` may be, `null` when it may be, `never` when it is neither.
 * An intersection rather than `Extract`, for the reason above `get`.
 */
type Nullish<V> = V & (null | undefined);

/**
 * A key that contains a dot is read whole and is checked first, so a config whose
 * top-level key is literally `"a.b"` resolves the way it always did - and so does
 * every key with no dot in it, which is every call written before paths existed.
 */
const read = (values: object, path: string): unknown => {
  if (path in values) return (values as Record<string, unknown>)[path];

  let current: unknown = values;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

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
 *
 * **Paths are overloads per depth, not one recursive conditional type.** A
 * conditional over `T` anywhere in this class makes its variance unmeasurable, so
 * `app.get(ConfigService)` compares type arguments invariantly, infers `never`
 * from `Ctor`'s `never[]` parameters and fails. Measured: every conditional-typed
 * signature broke that call, and the template-literal form is what does not.
 */
export class ConfigService<T extends object = Record<string, unknown>> {
  /**
   * The whole validated object, for destructuring or passing on, and what to
   * reach for past the three segments `get` types.
   */
  readonly values: T;

  constructor(values: T) {
    this.values = values;
  }

  /**
   * A top-level key, or a dotted path up to three segments deep. Both are checked
   * against `T`, so a path that does not exist is a compile error and the return
   * type is the value at that path.
   *
   * ```ts
   * config.get('port'); // number
   * config.get('db.host'); // string
   * config.get('cache.ttl'); // number | undefined, when `cache` is optional
   * ```
   *
   * A nullable step keeps its `null` or `undefined` in the return type, and reads
   * as `undefined` at runtime rather than throwing. `config.values.a.b.c.d` is
   * still there for anything deeper.
   */
  get<K extends keyof T>(key: K): T[K];
  get<
    A extends Extract<keyof T, string>,
    B extends Extract<keyof NonNullable<T[A]>, string>,
  >(path: `${A}.${B}`): NonNullable<T[A]>[B] | Nullish<T[A]>;
  get<
    A extends Extract<keyof T, string>,
    B extends Extract<keyof NonNullable<T[A]>, string>,
    C extends Extract<keyof NonNullable<NonNullable<T[A]>[B]>, string>,
  >(
    path: `${A}.${B}.${C}`,
  ):
    | NonNullable<NonNullable<T[A]>[B]>[C]
    | Nullish<T[A]>
    | Nullish<NonNullable<T[A]>[B]>;
  get(path: string): unknown {
    return read(this.values, path);
  }

  /**
   * Named for the convention it follows. Guards the value being present, not
   * the key being declared - a missing key is already a type error. Takes the
   * same paths `get` does.
   */
  getOrThrow<K extends keyof T>(key: K): NonNullable<T[K]>;
  getOrThrow<
    A extends Extract<keyof T, string>,
    B extends Extract<keyof NonNullable<T[A]>, string>,
  >(path: `${A}.${B}`): NonNullable<NonNullable<T[A]>[B]>;
  getOrThrow<
    A extends Extract<keyof T, string>,
    B extends Extract<keyof NonNullable<T[A]>, string>,
    C extends Extract<keyof NonNullable<NonNullable<T[A]>[B]>, string>,
  >(path: `${A}.${B}.${C}`): NonNullable<NonNullable<NonNullable<T[A]>[B]>[C]>;
  getOrThrow(path: string): unknown {
    const value = read(this.values, path);
    if (value === undefined || value === null) {
      throw new ConfigError(`Config key "${path}" is not set`);
    }
    return value;
  }
}
