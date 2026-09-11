import { resolve } from 'node:path';
import { ConfigError } from './service.js';

/** A source whose values are already typed, as a parsed file's are. */
export type ConfigValues = Record<string, unknown>;

const isPlainObject = (value: unknown): value is ConfigValues =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

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
const parse = (path: string, text: string): unknown => {
  const lower = path.toLowerCase();
  if (lower.endsWith('.yml') || lower.endsWith('.yaml')) {
    return Bun.YAML.parse(text);
  }
  if (lower.endsWith('.toml')) return Bun.TOML.parse(text);
  if (lower.endsWith('.json')) return JSON.parse(text) as unknown;

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

      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = parse(path, text);
      } catch (cause) {
        // The parser names the line but not the file: it was handed a string.
        throw new ConfigError(
          `Config file "${path}" did not parse: ${(cause as Error).message}`,
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

      values = merge(values, parsed);
    }

    return values;
  }
}
