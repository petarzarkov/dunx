import { resolve } from 'node:path';
import { isPlainObject } from '../plain-object.js';
import { ConfigError } from './service.js';

/** A source whose values are already typed, as a parsed file's are. */
export type ConfigValues = Record<string, unknown>;

/**
 * Every `__proto__` the parser produced, gone, before anything merges or is
 * handed out.
 *
 * A parser makes it an **own** property, so it survives until something assigns
 * it onward: `out.__proto__ = value` and `Object.assign({}, element)` both reach
 * the inherited setter and repoint the target rather than adding a key, and then
 * `config.get('isAdmin')` answers whatever the file said. Done here rather than
 * in {@link merge} because an array is replaced whole and never merged, so a
 * guard there would miss `hosts: [{ __proto__: ... }]`.
 */
const sanitize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!isPlainObject(value)) return value;

  const out: ConfigValues = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === '__proto__') continue;
    out[key] = sanitize(inner);
  }
  return out;
};

/** Later wins, per key: two objects merge, anything else replaces. */
const merge = (base: ConfigValues, overlay: ConfigValues): ConfigValues => {
  const out: ConfigValues = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key];
    out[key] =
      isPlainObject(existing) && isPlainObject(value)
        ? merge(existing, value)
        : value;
  }
  return out;
};

/** `Bun.YAML` and `Bun.TOML` are native, so no format here costs a dependency. */
const parserFor = (path: string): ((text: string) => unknown) => {
  const lower = path.toLowerCase();
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
    return (text) => Bun.YAML.parse(text);
  }
  if (lower.endsWith('.toml')) return (text) => Bun.TOML.parse(text);
  if (lower.endsWith('.json')) return (text) => JSON.parse(text) as unknown;

  throw new ConfigError(
    `Config file "${path}" has no parser. Use .yml, .yaml, .toml or .json.`,
  );
};

/**
 * The configuration files an app lists, read and merged into one object.
 *
 * ```ts
 * ConfigModule.forRoot({
 *   files: ['application.yml', `application-${Bun.env.NODE_ENV}.yml`],
 *   schema: configSchema,
 * });
 * ```
 *
 * Files are read in order and deep-merged, so a per-environment overlay overrides
 * only the keys it names. **A file that does not exist is skipped**, which is what
 * makes that overlay optional without the app testing for it first.
 *
 * There is no discovery: a file dunx was not given is a file dunx does not read.
 */
export class ConfigFiles {
  readonly #paths: readonly string[];
  readonly #cwd: string;

  constructor(paths: readonly string[], cwd: string = process.cwd()) {
    this.#paths = paths;
    this.#cwd = cwd;
  }

  /** The merged contents, `{}` when every path was absent. */
  async load(): Promise<ConfigValues> {
    let values: ConfigValues = {};

    for (const path of this.#paths) {
      const absolute = resolve(this.#cwd, path);
      const file = Bun.file(absolute);
      if (!(await file.exists())) continue;

      // Resolved before the try, so "no parser" is not rewrapped as "did not
      // parse", which named the file twice and contradicted itself.
      const parse = parserFor(path);
      const text = await file.text();
      // Empty means the same as absent, and only YAML agreed on its own:
      // `Bun.TOML.parse('')` answers `{}` but `JSON.parse('')` throws, so an
      // empty `.json` failed boot where an empty `.yml` was skipped.
      if (text.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = parse(text);
      } catch (cause) {
        // The parser names the line but not the file: it was handed a string.
        throw new ConfigError(
          `Config file "${path}" did not parse: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        );
      }

      // An empty file, or one holding only comments, parses to null.
      if (parsed === null || parsed === undefined) continue;

      if (!isPlainObject(parsed)) {
        throw new ConfigError(
          `Config file "${path}" must hold an object at the top level, got ${
            Array.isArray(parsed) ? 'an array' : typeof parsed
          }. A YAML file with a \`---\` document separator parses as an array.`,
        );
      }

      values = merge(values, sanitize(parsed) as ConfigValues);
    }

    return values;
  }
}
