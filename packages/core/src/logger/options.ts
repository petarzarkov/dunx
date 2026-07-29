import { colorsSupported } from './colors.js';
import { DEFAULT_MASK_FIELDS, LogLevel, type LoggerConfig } from './types.js';

/**
 * `LoggerConfig` with every default applied, modelled as an `abstract class` so it
 * is a runtime value and therefore a usable injection token — an `interface` would
 * erase and `@dunx/compiler` would record the parameter as `unresolved`.
 *
 * Resolve it to read what the logger actually settled on:
 * `constructor(private readonly options: LoggerOptions) {}`.
 */
export abstract class LoggerOptions {
  abstract readonly level: LogLevel;
  /** `name-version-env`, present only when all three were configured. */
  abstract readonly appId: string | undefined;
  /** Whether entries are written as coloured JSON. */
  abstract readonly colors: boolean;
  abstract readonly maskFields: readonly string[];
  abstract readonly filterEvents: readonly string[];
  abstract readonly maxArrayLength: number;
  abstract readonly maxDepth: number;
}

/**
 * `colors` is the one field with a composite default: development *and* a runtime
 * that says colour is supported. That second half is what keeps a log file clean —
 * `NO_COLOR`, a pipe, or a non-TTY all make `Bun.enableANSIColors` false, and
 * `isDevelopment` alone would happily fill the file with escape sequences.
 * An explicit `colors` overrides both, in either direction.
 */
export const resolveLoggerOptions = (
  config: LoggerConfig = {},
): LoggerOptions => {
  const isDevelopment =
    config.isDevelopment ?? process.env['NODE_ENV'] !== 'production';
  const extra = config.maskFields ?? [];

  return Object.freeze({
    level: config.level ?? LogLevel.DEBUG,
    appId:
      config.name !== undefined &&
      config.version !== undefined &&
      config.env !== undefined
        ? `${config.name}-${config.version}-${config.env}`
        : undefined,
    colors: config.colors ?? (isDevelopment && colorsSupported()),
    maskFields: Object.freeze([...new Set([...DEFAULT_MASK_FIELDS, ...extra])]),
    filterEvents: Object.freeze([...(config.filterEvents ?? [])]),
    maxArrayLength: config.maxArrayLength ?? 100,
    maxDepth: config.maxDepth ?? 32,
  });
};
