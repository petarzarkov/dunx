import { ConfigService, type ConfigSource, LogLevel } from '@dunx/core';
import { z } from 'zod';

/**
 * One validation function, which is the whole `ConfigModule` contract. dunx does
 * not pick the library — this is zod because the routes already use it, and a
 * hand-written function that throws would work identically.
 *
 * `.default()` is where a value comes from when the variable is unset, so a clean
 * checkout boots with no `.env` at all. Bun loads `.env` and `.env.local` itself,
 * so there is nothing here that reads a file.
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(LogLevel).default(LogLevel.INFO),
  /** Unset means console only. Set it to also append JSON to a rotating file. */
  LOG_FILE: z.string().optional(),
  CORS_ORIGIN: z.string().default('https://example.com'),
  /** `:memory:` needs no server and leaves nothing behind, so restarts are clean. */
  DATABASE_FILE: z.string().default(':memory:'),
  /** Absent is fine: the cache routes report themselves degraded instead of failing. */
  REDIS_URL: z.string().optional(),
  IMAGE_QUALITY: z.coerce.number().int().min(1).max(100).default(82),
  /** better-auth signs session cookies with this. 32 characters is its own minimum. */
  AUTH_SECRET: z
    .string()
    .min(32)
    .default('playground-development-secret-not-for-production'),
});

/**
 * The one broker channel the websocket relay carries every topic on. Two apps
 * sharing a Redis need two of these; the second node in the chat demo needs this
 * exact one.
 */
export const RELAY_CHANNEL = 'playground:ws';

export interface AppConfig {
  readonly appName: string;
  readonly port: number;
  readonly corsOrigin: string;
  readonly seedUsers: readonly string[];
  readonly log: {
    readonly level: LogLevel;
    readonly file: string | undefined;
  };
  readonly database: { readonly file: string };
  readonly redis: { readonly url: string | undefined };
  readonly images: { readonly quality: number };
  readonly auth: { readonly secret: string };
}

/**
 * One name for the typed config everywhere. A subclass rather than
 * `ConfigService<AppConfig>` at each site because a factory's `inject: [...]`
 * carries no type argument — the class does, and it is a real runtime value, so
 * it is both a precise token and a usable constructor annotation.
 */
export class AppConfigService extends ConfigService<AppConfig> {}

/**
 * Flat variables in, a shaped object out — the reason `config.get('log')` hands
 * back a group rather than a lone string. Everything downstream reads this
 * shape; nothing downstream reads `process.env`.
 */
export const validate = (env: ConfigSource): AppConfig => {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n - ');
    throw new Error(`Configuration is invalid:\n - ${issues}`);
  }
  const value = parsed.data;

  return {
    appName: 'playground',
    port: value.PORT,
    corsOrigin: value.CORS_ORIGIN,
    seedUsers: ['ada', 'grace'],
    log: { level: value.LOG_LEVEL, file: value.LOG_FILE },
    database: { file: value.DATABASE_FILE },
    redis: { url: value.REDIS_URL },
    images: { quality: value.IMAGE_QUALITY },
    auth: { secret: value.AUTH_SECRET },
  };
};
