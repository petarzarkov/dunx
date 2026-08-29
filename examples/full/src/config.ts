import { ConfigService, type ConfigSource, LogLevel } from '@dunx/core';
import { z } from 'zod';

/**
 * One validation function is the whole `ConfigModule` contract. zod here because
 * the routes already use it; a hand-written function would work identically.
 * Bun loads `.env` itself, so nothing here reads a file.
 */
const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(LogLevel).default(LogLevel.INFO),
  /** Unset means console only. Set it to also append JSON to a rotating file. */
  LOG_FILE: z.string().optional(),
  /**
   * Both default to `false` in `@dunx/http`: reading a body is
   * `req.clone().text()`, and the pair costs about two thirds of the throughput
   * on `internal/bench`'s `validate` scenario.
   */
  /**
   * How an entry is rendered. `json` is what a shipper reads, `text` is the
   * human line for a terminal, `logfmt` is the `key=value` shape Loki and Splunk
   * parse without a schema.
   */
  LOG_FORMAT: z.enum(['json', 'text', 'logfmt']).default('json'),
  LOG_REQUEST_BODY: z.stringbool().default(true),
  LOG_RESPONSE_BODY: z.stringbool().default(true),
  CORS_ORIGIN: z.string().default('https://example.com'),
  /** `:memory:` needs no server and leaves nothing behind, so restarts are clean. */
  DATABASE_FILE: z.string().default(':memory:'),
  /** Absent is fine: the cache routes report themselves degraded instead of failing. */
  REDIS_URL: z.string().optional(),
  IMAGE_QUALITY: z.coerce.number().int().min(1).max(100).default(82),
  /** Generous, so per-route `@Throttle` is the interesting half. */
  THROTTLE_LIMIT: z.coerce.number().int().min(1).default(1000),
  THROTTLE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
  /** A `@Cron` with no zone of its own runs in this one. */
  SCHEDULE_TZ: z.string().default('UTC'),
  /** Per-call budget for the outbound client. */
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1).default(5000),
  /** better-auth signs session cookies with this. 32 characters is its own minimum. */
  AUTH_SECRET: z
    .string()
    .min(32)
    .default('dunx-full-example-development-secret-not-for-production'),
});

/** The broker channel the websocket relay carries every topic on. */
export const RELAY_CHANNEL = 'dunx-full:ws';

export interface AppConfig {
  readonly appName: string;
  readonly port: number;
  readonly corsOrigin: string;
  readonly seedUsers: readonly string[];
  readonly log: {
    readonly level: LogLevel;
    readonly file: string | undefined;
    readonly format: 'json' | 'text' | 'logfmt';
    readonly requestBody: boolean;
    readonly responseBody: boolean;
  };
  readonly database: { readonly file: string };
  readonly redis: { readonly url: string | undefined };
  readonly images: { readonly quality: number };
  readonly auth: { readonly secret: string };
  readonly throttle: { readonly limit: number; readonly windowSeconds: number };
  readonly schedule: { readonly tz: string };
  readonly upstream: { readonly timeoutMs: number };
}

/**
 * A subclass rather than `ConfigService<AppConfig>` at each site: a factory's
 * `inject: [...]` carries no type argument, and a class is a runtime value.
 */
export class AppConfigService extends ConfigService<AppConfig> {}

/** Flat variables in, a shaped object out. Nothing downstream reads the env. */
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
    appName: 'dunx-full',
    port: value.PORT,
    corsOrigin: value.CORS_ORIGIN,
    seedUsers: ['ada', 'grace'],
    log: {
      level: value.LOG_LEVEL,
      file: value.LOG_FILE,
      format: value.LOG_FORMAT,
      requestBody: value.LOG_REQUEST_BODY,
      responseBody: value.LOG_RESPONSE_BODY,
    },
    database: { file: value.DATABASE_FILE },
    redis: { url: value.REDIS_URL },
    images: { quality: value.IMAGE_QUALITY },
    auth: { secret: value.AUTH_SECRET },
    throttle: {
      limit: value.THROTTLE_LIMIT,
      windowSeconds: value.THROTTLE_WINDOW_SECONDS,
    },
    schedule: { tz: value.SCHEDULE_TZ },
    upstream: { timeoutMs: value.UPSTREAM_TIMEOUT_MS },
  };
};
