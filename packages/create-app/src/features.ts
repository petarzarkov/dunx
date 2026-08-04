/**
 * The features a generated app can be composed from, each one a directory of
 * `examples/full` - the example CI boots and tours on every push.
 *
 * That is the whole point of sourcing them there rather than writing starter code
 * here: a template nobody runs rots, and this repo already runs `examples/full`
 * end to end. `bun run sync:templates` copies the directories in and
 * `features.test.ts` fails if a copy drifts, so what gets scaffolded is what CI
 * proved works.
 *
 * What is **not** copied is the wiring: `app.module.ts`, `config.ts`,
 * `bootstrap.ts` and `main.ts` in the full example name every feature at once, so
 * they are generated from the selection instead. See `generate.ts`.
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
export interface ConfigGroup {
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
      ],
      field:
        'readonly log: { readonly level: LogLevel; readonly file: string | undefined };',
      map: 'log: { level: value.LOG_LEVEL, file: value.LOG_FILE },',
      env: [{ name: 'LOG_LEVEL', value: 'info' }],
    },
    corsOrigin: {
      schema: ["CORS_ORIGIN: z.string().default('https://example.com'),"],
      field: 'readonly corsOrigin: string;',
      map: 'corsOrigin: value.CORS_ORIGIN,',
      env: [{ name: 'CORS_ORIGIN', value: 'https://example.com' }],
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
    summary: 'OpenAPI 3.1 from the routes own schemas, plus the explorer page.',
    requires: [],
    module: { klass: 'DocsModule', from: './docs/docs.module.js' },
    dependencies: ['@dunx/openapi', 'zod'],
    config: [],
  },
  {
    name: 'http',
    source: 'http',
    summary: 'CORS, a request-logging middleware and error mapping.',
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
    requires: [],
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
    summary: 'bullmq queues and a worker, over Bun.RedisClient.',
    requires: ['images'],
    module: { klass: 'JobsModule', from: './jobs/jobs.module.js' },
    dependencies: ['@dunx/infra', 'bullmq', 'ioredis', 'zod'],
    config: ['redis'],
    service: 'Redis or Valkey',
  },
  {
    name: 'dashboard',
    source: 'dashboard',
    summary:
      'bull-board at /queues, over the queue the jobs feature publishes to.',
    requires: ['jobs'],
    module: {
      klass: 'DashboardModule',
      from: './dashboard/dashboard.module.js',
    },
    dependencies: [
      '@dunx/queue-dashboard',
      '@bull-board/api',
      '@bull-board/ui',
    ],
    config: ['appName'],
    service: 'Redis or Valkey',
  },
  {
    name: 'health',
    source: 'health',
    summary: 'One endpoint reporting which parts are live and which degraded.',
    requires: ['cache', 'database'],
    module: { klass: 'HealthModule', from: './health/health.module.js' },
    dependencies: ['@dunx/infra'],
    config: ['appName'],
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
