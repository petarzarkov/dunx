/**
 * The features a generated app can be composed from, each a directory of
 * `examples/full`, which CI boots and tours on every push - a template nobody runs
 * rots. `bun run sync:templates` copies them in and `features.test.ts` fails on
 * drift.
 *
 * The wiring is not copied: `app.module.ts`, `config.ts` and `main.ts` name every
 * feature at once, so they are generated from the selection.
 */
export interface Feature {
  /** Flag name, and the directory under `templates/features/`. */
  readonly name: string;
  /** The directory in `examples/full/src` this mirrors. */
  readonly source: string;
  readonly summary: string;
  /** Features this one imports from, pulled in automatically. */
  readonly requires: readonly string[];
  /** The module class to import, and the file it comes from. */
  readonly module: { readonly klass: string; readonly from: string };
  /** Runtime dependencies this feature adds to the generated manifest. */
  readonly dependencies: readonly string[];
  /** Config groups this feature reads, contributed to the generated config. */
  readonly config: readonly string[];
  /**
   * A service that has to be running for the feature to do anything. Named so the
   * prompt can say so and the generated README can list it, rather than the app
   * failing in a way the reader has to diagnose.
   */
  readonly service?: string;
}

/**
 * Config groups, keyed by the name a feature asks for. `env` is what lands in
 * `.env.example`, `schema` the zod line, `field` the `AppConfig` member and `map`
 * how the flat variable becomes the shaped one - the four things
 * `examples/full/src/config.ts` states for every group at once, split so a
 * selection can state only its own.
 */
interface ConfigGroup {
  readonly schema: readonly string[];
  readonly field: string;
  readonly map: string;
  readonly env: readonly { readonly name: string; readonly value: string }[];
}

export const CONFIG_GROUPS: Readonly<Record<string, ConfigGroup>> =
  Object.freeze({
    port: {
      schema: [
        'PORT: z.coerce.number().int().min(0).max(65535).default(3000),',
      ],
      field: 'readonly port: number;',
      map: 'port: value.PORT,',
      env: [{ name: 'PORT', value: '3000' }],
    },
    appName: {
      schema: [],
      field: 'readonly appName: string;',
      map: "appName: '__DUNX_APP_NAME__',",
      env: [],
    },
    log: {
      schema: [
        'LOG_LEVEL: z.enum(LogLevel).default(LogLevel.INFO),',
        '/** Unset means console only. Set it to also append JSON to a rotating file. */',
        'LOG_FILE: z.string().optional(),',
        '/** Both cost a `req.clone().text()` on the hot path, so off in production. */',
        'LOG_REQUEST_BODY: z.stringbool().default(false),',
        'LOG_RESPONSE_BODY: z.stringbool().default(false),',
      ],
      field:
        'readonly log: { readonly level: LogLevel; readonly file: string | undefined; ' +
        'readonly requestBody: boolean; readonly responseBody: boolean };',
      map:
        'log: { level: value.LOG_LEVEL, file: value.LOG_FILE, ' +
        'requestBody: value.LOG_REQUEST_BODY, responseBody: value.LOG_RESPONSE_BODY },',
      env: [{ name: 'LOG_LEVEL', value: 'info' }],
    },
    corsOrigin: {
      schema: [
        "CORS_ORIGIN: z.string().default('https://example.com'),",
        '/**',
        ' * Whether `x-forwarded-for` is believed. Off unless a trusted proxy is in',
        ' * front: with nothing stripping the header, any caller picks its own',
        ' * address, which fakes both rate limiting and the logged client address.',
        ' */',
        'TRUST_PROXY: z.stringbool().default(false),',
      ],
      field: 'readonly corsOrigin: string;\n  readonly trustProxy: boolean;',
      map: 'corsOrigin: value.CORS_ORIGIN,\n    trustProxy: value.TRUST_PROXY,',
      env: [
        { name: 'CORS_ORIGIN', value: 'https://example.com' },
        // Written to `.env.example` so the setting is visible rather than only
        // implied by the schema default.
        { name: 'TRUST_PROXY', value: 'false' },
      ],
    },
    database: {
      schema: [
        '/** `:memory:` needs no server and leaves nothing behind, so restarts are clean. */',
        "DATABASE_FILE: z.string().default(':memory:'),",
      ],
      field: 'readonly database: { readonly file: string };',
      map: 'database: { file: value.DATABASE_FILE },',
      env: [{ name: 'DATABASE_FILE', value: ':memory:' }],
    },
    redis: {
      schema: [
        '/** Absent is fine: the cache routes report themselves degraded instead of failing. */',
        'REDIS_URL: z.string().optional(),',
      ],
      field: 'readonly redis: { readonly url: string | undefined };',
      map: 'redis: { url: value.REDIS_URL },',
      env: [{ name: 'REDIS_URL', value: 'redis://localhost:6379' }],
    },
    images: {
      schema: [
        'IMAGE_QUALITY: z.coerce.number().int().min(1).max(100).default(82),',
      ],
      field: 'readonly images: { readonly quality: number };',
      map: 'images: { quality: value.IMAGE_QUALITY },',
      env: [{ name: 'IMAGE_QUALITY', value: '82' }],
    },
    auth: {
      schema: [
        '/** better-auth signs session cookies with this. 32 characters is its own minimum. */',
        "AUTH_SECRET: z.string().min(32).default('dunx-development-secret-not-for-production'),",
      ],
      field: 'readonly auth: { readonly secret: string };',
      map: 'auth: { secret: value.AUTH_SECRET },',
      env: [
        {
          name: 'AUTH_SECRET',
          value: 'change-me-to-at-least-32-characters-long',
        },
      ],
    },
    seedUsers: {
      schema: [],
      field: 'readonly seedUsers: readonly string[];',
      map: "seedUsers: ['ada', 'grace'],",
      env: [],
    },
    authorization: {
      schema: [],
      field: 'readonly authorization: { readonly enabled: boolean };',
      map: 'authorization: { enabled: true },',
      env: [],
    },
    throttle: {
      schema: [
        '/** The app-wide limit. Generous, so a per-route `@Throttle` is the interesting half. */',
        'THROTTLE_LIMIT: z.coerce.number().int().min(1).default(1000),',
        'THROTTLE_WINDOW_SECONDS: z.coerce.number().int().min(1).default(60),',
      ],
      field:
        'readonly throttle: { readonly limit: number; readonly windowSeconds: number };',
      map: 'throttle: { limit: value.THROTTLE_LIMIT, windowSeconds: value.THROTTLE_WINDOW_SECONDS },',
      env: [
        { name: 'THROTTLE_LIMIT', value: '1000' },
        { name: 'THROTTLE_WINDOW_SECONDS', value: '60' },
      ],
    },
    schedule: {
      schema: [
        '/** A `@Cron` that names no zone of its own runs in this one. */',
        "SCHEDULE_TZ: z.string().default('UTC'),",
      ],
      field: 'readonly schedule: { readonly tz: string };',
      map: 'schedule: { tz: value.SCHEDULE_TZ },',
      env: [{ name: 'SCHEDULE_TZ', value: 'UTC' }],
    },
    upstream: {
      schema: [
        '/** Per-call budget for the outbound client. */',
        'UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1).default(5000),',
      ],
      field: 'readonly upstream: { readonly timeoutMs: number };',
      map: 'upstream: { timeoutMs: value.UPSTREAM_TIMEOUT_MS },',
      env: [{ name: 'UPSTREAM_TIMEOUT_MS', value: '5000' }],
    },
  });

/** Always present, whatever is selected: the port and the logger need them. */
export const BASE_CONFIG: readonly string[] = ['appName', 'port', 'log'];

export const FEATURES: readonly Feature[] = [
  {
    name: 'notes',
    source: 'notes',
    summary: 'CRUD routes with zod validation. The smallest real feature.',
    requires: [],
    module: { klass: 'NotesModule', from: './notes/notes.module.js' },
    dependencies: ['@dunx/openapi', 'zod'],
    config: [],
  },
  {
    name: 'openapi',
    source: 'docs',
    summary:
      'OpenAPI 3.1 from the routes own schemas, plus the Swagger UI page.',
    requires: [],
    module: { klass: 'DocsModule', from: './docs/docs.module.js' },
    // No `swagger-ui-dist` here: it is a hard dependency of `@dunx/openapi`, so
    // it arrives transitively and a scaffolded app never names it.
    dependencies: ['@dunx/openapi', 'zod'],
    config: [],
  },
  {
    name: 'http',
    source: 'http',
    summary:
      'CORS, a middleware of your own on the response, and error mapping.',
    requires: [],
    module: { klass: 'HttpModule', from: './http/http.module.js' },
    dependencies: [],
    config: ['corsOrigin'],
  },
  {
    name: 'guards',
    source: 'guards',
    summary:
      'Route guards with @Roles and @Public, and a protected controller.',
    requires: [],
    module: { klass: 'GuardsModule', from: './guards/guards.module.js' },
    dependencies: ['zod'],
    config: ['authorization'],
  },
  {
    name: 'database',
    source: 'database',
    summary: 'drizzle over bun:sqlite, with a schema, seeds and migrations.',
    requires: [],
    module: { klass: 'DatabaseModule', from: './database/database.module.js' },
    dependencies: ['@dunx/infra', 'drizzle-orm', 'zod'],
    config: ['database'],
  },
  {
    name: 'users',
    source: 'users',
    summary: 'A repository, a service and validated routes over the database.',
    requires: ['database'],
    module: { klass: 'UsersModule', from: './users/users.module.js' },
    dependencies: ['@dunx/infra', 'drizzle-orm', 'zod'],
    config: ['appName', 'seedUsers'],
  },
  {
    name: 'auth',
    source: 'auth',
    summary: 'better-auth mounted, with SessionGuard and an audit trail.',
    requires: ['database'],
    module: { klass: 'AccountsModule', from: './auth/auth.module.js' },
    dependencies: ['@dunx/auth', 'better-auth', 'drizzle-orm'],
    config: ['auth', 'port'],
  },
  {
    name: 'cache',
    source: 'cache',
    summary: 'Bun.RedisClient behind a session store, degrading when absent.',
    requires: [],
    module: { klass: 'CacheModule', from: './cache/cache.module.js' },
    dependencies: ['@dunx/infra', 'zod'],
    config: ['redis'],
    service: 'Redis or Valkey',
  },
  {
    name: 'websockets',
    source: 'chat',
    summary: 'A @Gateway with @OnMessage events, PubSub and a Redis relay.',
    // `cache` joined this list for the same reason `files` joined health's: the gateway
    // injects `RedisConnection` for cross-process fan-out, and a module now has to
    // import the one that provides it. The summary already said "and a Redis relay".
    requires: ['cache'],
    module: { klass: 'ChatModule', from: './chat/chat.module.js' },
    dependencies: ['@dunx/infra'],
    config: [],
    service: 'Redis or Valkey, for multi-node fan-out only',
  },
  {
    name: 'images',
    source: 'pictures',
    summary: 'Bun.Image resizing and format conversion behind a route.',
    requires: [],
    module: { klass: 'PicturesModule', from: './pictures/pictures.module.js' },
    dependencies: ['@dunx/infra', 'zod'],
    config: ['images'],
  },
  {
    name: 'files',
    source: 'storage',
    summary: 'Uploads and downloads on Bun.file, with a workspace root.',
    requires: [],
    module: { klass: 'StorageModule', from: './storage/storage.module.js' },
    dependencies: ['@dunx/infra', 'zod'],
    config: [],
  },
  {
    name: 'jobs',
    source: 'jobs',
    summary: 'bullmq queues over Bun.RedisClient, background handlers forked.',
    requires: ['images'],
    module: { klass: 'JobsModule', from: './jobs/jobs.module.js' },
    dependencies: ['@dunx/infra', 'bullmq', 'ioredis', 'zod'],
    config: ['redis'],
    service: 'Redis or Valkey',
  },
  {
    name: 'health',
    source: 'health',
    summary:
      "`HealthModule`'s liveness and readiness probes, wired to this app's own indicators.",
    // Each one supplies an indicator: `cache` the Redis connection, `database` the
    // connection and the `Ledger` the custom check queries, `files` the `Workspace`
    // whose directory the disk check measures. Selecting health without them used
    // to typecheck and fail at boot.
    requires: ['cache', 'database', 'files'],
    module: { klass: 'ProbesModule', from: './health/health.module.js' },
    dependencies: ['@dunx/infra'],
    config: ['appName'],
  },
  {
    name: 'throttle',
    source: 'throttle',
    summary:
      'A fixed-window rate limit, with the counter in Redis and per-route overrides.',
    // `cache` for the `RedisConnection` the shared counter writes to. The
    // in-process default needs nothing, but it is per replica, so the example
    // shows the one that survives a second pod.
    requires: ['cache'],
    module: { klass: 'LimitsModule', from: './throttle/throttle.module.js' },
    dependencies: ['@dunx/infra'],
    config: ['appName', 'throttle'],
    service: 'Redis or Valkey',
  },
  {
    name: 'schedule',
    source: 'schedule',
    summary:
      '@Cron, @Interval and @OnceOnBoot on Bun.cron, armed at boot and triggerable.',
    requires: [],
    module: {
      klass: 'MaintenanceModule',
      from: './schedule/schedule.module.js',
    },
    dependencies: ['@dunx/infra'],
    config: ['schedule'],
  },
  {
    name: 'assets',
    source: 'assets',
    summary:
      'A static directory on Bun.file, with a short max-age and an immutable rule.',
    requires: [],
    module: { klass: 'AssetsModule', from: './assets/assets.module.js' },
    dependencies: [],
    config: [],
  },
  {
    name: 'client',
    source: 'upstream',
    summary:
      'The outbound half of @dunx/http: retry, backoff and a typed FetchError.',
    requires: [],
    module: { klass: 'UpstreamModule', from: './upstream/upstream.module.js' },
    dependencies: [],
    config: ['appName', 'upstream'],
  },
];

export const featureNames: readonly string[] = FEATURES.map(
  (feature) => feature.name,
);

const byName = new Map(FEATURES.map((feature) => [feature.name, feature]));

export class UnknownFeatureError extends Error {
  override readonly name = 'UnknownFeatureError';
}

/**
 * The selection plus everything it requires, in **import order** - which is
 * construction order, and shutdown runs in reverse. A feature is emitted after
 * everything it requires, so the database outlives the features reading it, the
 * same ordering `examples/full/src/app.module.ts` states by hand.
 *
 * Depth-first over `requires`, with a visited set, so a diamond resolves once and
 * the result is stable whatever order the caller asked in.
 */
export const resolveFeatures = (
  requested: readonly string[],
): readonly Feature[] => {
  const unknown = requested.filter((name) => !byName.has(name));
  if (unknown.length > 0) {
    throw new UnknownFeatureError(
      `Unknown feature${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}. ` +
        `Available: ${featureNames.join(', ')}.`,
    );
  }

  const ordered: Feature[] = [];
  const seen = new Set<string>();
  const rank = new Map(FEATURES.map((feature, at) => [feature.name, at]));

  const visit = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    const feature = byName.get(name);
    if (!feature) return;
    // Requirements in **registry order**, not in the order this feature happens to
    // list them: two independent requirements would otherwise come out in the
    // order they were typed, which is not a statement about construction order and
    // would make `requires: ['cache', 'database']` build the cache first.
    for (const required of [...feature.requires].sort(
      (left, right) => (rank.get(left) ?? 0) - (rank.get(right) ?? 0),
    )) {
      visit(required);
    }
    ordered.push(feature);
  };

  // Registry order, not request order, so two runs asking for the same set in a
  // different order generate byte-identical files.
  for (const feature of FEATURES) {
    if (requested.includes(feature.name)) visit(feature.name);
  }

  return ordered;
};

/** Which of the resolved features the caller did not ask for. */
export const impliedBy = (
  requested: readonly string[],
  resolved: readonly Feature[],
): readonly string[] =>
  resolved
    .map((feature) => feature.name)
    .filter((name) => !requested.includes(name));
