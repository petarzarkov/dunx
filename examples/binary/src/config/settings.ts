import { ConfigService, type ConfigSource, LogLevel } from '@dunx/core';
import pkg from '../../package.json' with { type: 'json' };

/**
 * The version, inlined by the bundler at build time. A JSON import is the only
 * stamping that survives `--compile`: a compiled binary ignores `--define` and
 * resolves `process.env` at runtime. See README.md.
 */
export const CLI_VERSION: string = pkg.version;

export const CLI_NAME = 'pulse';

export interface CliConfig {
  readonly name: string;
  readonly version: string;
  readonly logLevel: LogLevel;
}

/** A subclass so `inject: [CliConfigService]` keeps the type a factory needs. */
export class CliConfigService extends ConfigService<CliConfig> {}

const LEVELS = new Set<string>(Object.values(LogLevel));

/**
 * A hand-written validate rather than a schema: `ConfigModule` takes a function,
 * and one that throws works the way zod's `parse` does. It keeps the binary to
 * three dependencies, which is half the point of shipping one.
 */
export const validate = (env: ConfigSource): CliConfig => {
  const level = env['LOG_LEVEL'] ?? LogLevel.INFO;
  if (!LEVELS.has(level)) {
    throw new Error(
      `LOG_LEVEL must be one of ${[...LEVELS].join(', ')}, got "${level}"`,
    );
  }
  return {
    name: CLI_NAME,
    version: CLI_VERSION,
    logLevel: level as LogLevel,
  };
};
