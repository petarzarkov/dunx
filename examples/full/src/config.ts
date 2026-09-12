import {
  ConfigModule,
  ConfigService,
  type ConfigSource,
  type ConfigValues,
  type DynamicModule,
  LogLevel,
} from '@dunx/core';
import { join } from 'node:path';
import { z } from 'zod';

/** Merged in order before validating. The overlay is absent, so it is skipped. */
export const configFiles = [
  join(import.meta.dir, '..', 'application.yml'),
  join(
    import.meta.dir,
    '..',
    `application-${Bun.env.NODE_ENV ?? 'development'}.yml`,
  ),
];

/**
 * One validation function is the whole `ConfigModule` contract. zod here because
 * the routes already use it; a hand-written function would work identically.
 * Bun loads `.env` itself, and `files` supplies what a flat variable cannot.
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
  /**
   * Whether `x-forwarded-for` is believed. **Off unless a trusted proxy is in
   * front**: with nothing stripping the header, any caller picks its own address,
   * which fakes the throttle subject and the address in every log line.
   */
  TRUST_PROXY: z.stringbool().default(false),
  /** The origin a browser reaches this app on. Absent means localhost. */
  PUBLIC_URL: z.url().optional(),
  /** Absent is fine: the cache routes report themselves degraded instead of failing. */
  REDIS_URL: z.string().optional(),
  /** Absent is fine: the messaging routes answer 503 and the tour skips. */
  RABBITMQ_URL: z.string().optional(),
  IMAGE_QUALITY: z.coerce.number().int().min(1).max(100).default(82),
  /** Generous, so per-route `@Throttle` is the interesting half. */
  THROTTLE_LIMIT: z.coerce.number().int().min(1).default(1000),
  THROTTLE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),
  /** A `@Cron` with no zone of its own runs in this one. */
  SCHEDULE_TZ: z.string().default('UTC'),
  /** Per-call budget for the outbound client. */
  UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1).default(5000),
  /**
   * Guards the ops page when set. Absent by default so `bun start` is
   * explorable and `@dunx/dashboard` still warns that it is unguarded.
   */
  DASHBOARD_TOKEN: z.string().min(1).optional(),
  /** bull-board's `readOnlyMode`, inverted. The public demo sets it false. */
  DASHBOARD_COMMANDS: z.stringbool().default(true),
  /** better-auth signs session cookies with this. 32 characters is its own minimum. */
  AUTH_SECRET: z
    .string()
    .min(32)
    .default('dunx-full-example-development-secret-not-for-production'),
  /** No sign-up; a guest account per visitor instead. The public demo's shape. */
  AUTH_GUEST_ONLY: z.stringbool().default(false),
  AUTH_SESSION_DAYS: z.coerce.number().int().min(1).default(7),
  /** From `application.yml`. No default, so a missing file fails boot here. */
  seed: z.object({ users: z.array(z.string()).min(1) }),
});

/** The broker channel the websocket relay carries every topic on. */
export const RELAY_CHANNEL = 'dunx-full:ws';

export interface AppConfig {
  readonly appName: string;
  readonly port: number;
  readonly corsOrigin: string;
  readonly trustProxy: boolean;
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
  readonly amqp: { readonly url: string | undefined };
  readonly images: { readonly quality: number };
  readonly auth: {
    readonly secret: string;
    readonly guestOnly: boolean;
    readonly sessionDays: number;
  };
  readonly dashboard: {
    readonly token: string | undefined;
    readonly commands: boolean;
  };
  readonly throttle: { readonly limit: number; readonly windowSeconds: number };
  readonly schedule: { readonly tz: string };
  readonly upstream: { readonly timeoutMs: number };
  readonly publicUrl: string;
}

/**
 * A subclass rather than `ConfigService<AppConfig>` at each site: a factory's
 * `inject: [...]` carries no type argument, and a class is a runtime value.
 */
export class AppConfigService extends ConfigService<AppConfig> {}

/**
 * One place: the forked queue processor and every test slice need the same
 * `files`. `source` is all a caller varies, standing in for the environment.
 */
export const configModule = (source?: ConfigSource): DynamicModule =>
  ConfigModule.forRoot({
    files: configFiles,
    validate,
    as: AppConfigService,
    ...(source === undefined ? {} : { source }),
  });

/** Flat variables in, a shaped object out. Nothing downstream reads the env. */
export const validate = (env: ConfigValues): AppConfig => {
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
    trustProxy: value.TRUST_PROXY,
    seedUsers: value.seed.users,
    log: {
      level: value.LOG_LEVEL,
      file: value.LOG_FILE,
      format: value.LOG_FORMAT,
      requestBody: value.LOG_REQUEST_BODY,
      responseBody: value.LOG_RESPONSE_BODY,
    },
    database: { file: value.DATABASE_FILE },
    redis: { url: value.REDIS_URL },
    amqp: { url: value.RABBITMQ_URL },
    images: { quality: value.IMAGE_QUALITY },
    auth: {
      secret: value.AUTH_SECRET,
      guestOnly: value.AUTH_GUEST_ONLY,
      sessionDays: value.AUTH_SESSION_DAYS,
    },
    dashboard: {
      token: value.DASHBOARD_TOKEN,
      commands: value.DASHBOARD_COMMANDS,
    },
    throttle: {
      limit: value.THROTTLE_LIMIT,
      windowSeconds: value.THROTTLE_WINDOW_SECONDS,
    },
    schedule: { tz: value.SCHEDULE_TZ },
    upstream: { timeoutMs: value.UPSTREAM_TIMEOUT_MS },
    publicUrl: value.PUBLIC_URL ?? `http://localhost:${value.PORT}`,
  };
};
