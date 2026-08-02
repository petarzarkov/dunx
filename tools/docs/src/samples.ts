/**
 * The landing page's code samples. Every one of these is lifted from the
 * example app rather than written for the page, because a sample that was never
 * run is a liability - the whole point of the tour is that this is what the
 * framework actually looks like.
 */
export interface Sample {
  readonly id: string;
  readonly label: string;
  readonly file: string;
  readonly blurb: string;
  readonly code: string;
}

export const SAMPLES: readonly Sample[] = [
  {
    id: 'routes',
    label: 'Routes',
    file: 'users.controller.ts',
    blurb:
      'The body arrives validated and typed. No req.json(), no Response.json(), no manual status - 201 is the POST default, and a thrown HttpError is mapped for you.',
    code: `@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('/', listUsers)
  list(input: Input<typeof listUsers>): Promise<readonly User[]> {
    return this.users.findAll(input.query.limit, input.query.q);
  }

  @Get('/:id', oneUser)
  async one(input: Input<typeof oneUser>): Promise<User> {
    // Already a number: the params schema coerced it before this ran.
    const user = await this.users.find(input.params.id);
    if (user === null) {
      throw new HttpError(HttpStatusCode.NOT_FOUND, \`No user \${input.params.id}\`);
    }
    return user;
  }

  @Post('/', createUser)
  create(input: Input<typeof createUser>): Promise<User> {
    return this.users.create(input.body.name, input.body.tags);
  }
}`,
  },
  {
    id: 'validation',
    label: 'Validation',
    file: 'users.schemas.ts',
    blurb:
      'Real zod, dropped straight into a route. z.object() already carries ~standard, which is the entire contract @dunx/http validates against - so nothing adapts anything, and the framework depends on no validator. Valibot and ArkType work the same way.',
    code: `export const Tag = z
  .object({ label: z.string().min(1) })
  .meta({ id: 'Tag', title: 'A label attached to a user' });

export const createUser = {
  body: z.object({
    name: z.string().min(1).max(40),
    tags: z.array(Tag).default([]),
  }),
} satisfies RouteSchemas;

// Path params arrive as strings; z.coerce is where :id becomes a number.
export const oneUser = {
  params: z.object({ id: z.coerce.number().int().positive() }),
} satisfies RouteSchemas;`,
  },
  {
    id: 'modules',
    label: 'Modules',
    file: 'app.module.ts',
    blurb:
      'Import order is construction order, and shutdown runs in reverse - so config and the logger are built first and torn down last, and the database outlives every feature that uses it.',
    code: `@Module({
  imports: [
    ConfigModule.forRoot({ validate, as: AppConfigService }),
    LoggerModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        level: config.get('logLevel'),
      }),
      inject: [AppConfigService],
    }),
    DatabaseModule,
    UsersModule,
  ],
  controllers: [HealthController],
  providers: [Tour],
})
export class AppModule {}`,
  },
  {
    id: 'config',
    label: 'Config',
    file: 'config.ts',
    blurb:
      'One validation function, which is the whole ConfigModule contract - it takes the raw env and returns the shaped, typed object, and whatever it throws is what boot fails with. dunx does not pick the library; a hand-written function works identically and costs no dependency. Bun loads .env itself, so there is no loader and no dotenv.',
    code: `const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(LogLevel).default(LogLevel.INFO),
  DATABASE_FILE: z.string().default(':memory:'),
  REDIS_URL: z.string().optional(),
});

export const validate = (env: ConfigSource): AppConfig => {
  const parsed = envSchema.parse(env);
  return {
    port: parsed.PORT,
    logLevel: parsed.LOG_LEVEL,
    database: { file: parsed.DATABASE_FILE },
    redis: { url: parsed.REDIS_URL },
  };
};

// The subclass is what keeps the type through a factory's inject: [...].
export class AppConfigService extends ConfigService<AppConfig> {}`,
  },
  {
    id: 'database',
    label: 'Database',
    file: 'database.module.ts',
    blurb:
      'drizzle over bun:sqlite and Bun.SQL - dunx does not write an ORM. SyncSqliteOptions runs SQLite in synchronous mode, which binds the SyncDatabase token and makes transactionSync reachable. dunx settles every async factory before the first constructor runs, so the connection is open and its pragmas applied by the time a repository is built.',
    code: `DbModule.forRootAsync(SyncDatabase, {
  useFactory: (config: AppConfigService) =>
    new SyncSqliteOptions({
      schema,
      filename: config.get('database').file,
      pragmas: ['foreign_keys = ON'],
    }),
  inject: [AppConfigService],
});

// A repository just asks for the handle.
export class Ledger {
  constructor(private readonly db: SyncDatabase<typeof schema>) {}

  balances() {
    return this.db.select().from(schema.accounts).all();
  }
}`,
  },
  {
    id: 'websockets',
    label: 'WebSockets',
    file: 'chat.gateway.ts',
    blurb:
      'Served by the same Bun.serve call as the HTTP routes: HttpFactory discovers the gateway from providers and listen() mounts the upgrade as a native route. Topics live in the runtime - Bun’s own pub/sub, not a JavaScript map.',
    code: `@Gateway('/chat')
export class ChatGateway {
  constructor(
    private readonly lobby: Lobby,
    private readonly logger: Logger,
  ) {}

  @OnOpen()
  opened(socket: Socket): void {
    socket.subscribe(Lobby.TOPIC);
    socket.send('welcome');
  }

  @OnMessage('say')
  say(text: string): { delivered: number } {
    // The return value is replied to the sender under the same event name.
    return { delivered: this.lobby.broadcast(text) };
  }

  @OnClose()
  closed(socket: Socket, code: number): void {
    this.logger.info(\`\${socket.data.path} closed with \${code}\`);
  }
}`,
  },
  {
    id: 'queues',
    label: 'Queues',
    file: 'jobs.module.ts',
    blurb:
      'bullmq, driven through Bun.RedisClient by bullmq’s own Bun adapter - no ioredis in dunx’s output. forRoot binds the publish side alone, so a web process that publishes never opens a worker by accident.',
    code: `@Module({
  imports: [
    QueueModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        url: config.get('redis').url,
        prefix: 'playground',
      }),
      inject: [AppConfigService] as const,
    }),
  ],
  providers: [ThumbnailJobs],
})
export class JobsModule {}`,
  },
  {
    id: 'testing',
    label: 'Testing',
    file: 'overrides.test.ts',
    blurb:
      'A slice of the real app in a container of its own, with one provider replaced in place. Logger is the interesting override: no module binds it, @dunx/core offers ConsoleLogger as a default after every module, and the substitution applies there too.',
    code: `it('boots the users slice with the logger replaced', async () => {
  const logger = new RecordingLogger();

  const app = await createTestApp({
    modules: [
      ConfigModule.forRoot({ validate, as: AppConfigService }),
      DatabaseModule,
      UsersModule,
    ],
    overrides: [provide(Logger, { useValue: logger })],
  });

  await app.get(UsersService).create('ada', []);
  expect(logger.entries).toHaveLength(1);
});`,
  },
  {
    id: 'bootstrap',
    label: 'Bootstrap',
    file: 'main.ts',
    blurb:
      'Nothing else to do: the server holds the process open, and the shutdown hooks resolve app.closed once a signal arrives.',
    code: `const app = await HttpFactory.create(AppModule);
app.enableShutdownHooks();

const url = await app.listen(3000);
app.get(Logger).info(\`listening on \${url}\`);

await app.closed;`,
  },
];

/** The hero's editor frame. */
export const HERO_FILES: readonly Sample[] = [
  {
    id: 'hero-service',
    label: 'users.service.ts',
    file: 'users.service.ts',
    blurb: '',
    code: `export class UsersRepository {
  constructor(private readonly db: DbConnection) {}
}

export class UsersService {
  constructor(private readonly repo: UsersRepository) {}

  findAll() {
    return this.repo.all();
  }
}`,
  },
  {
    id: 'hero-controller',
    label: 'users.controller.ts',
    file: 'users.controller.ts',
    blurb: '',
    code: `@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('/')
  list() {
    return this.users.findAll();
  }
}`,
  },
  {
    id: 'hero-main',
    label: 'main.ts',
    file: 'main.ts',
    blurb: '',
    code: `import { HttpFactory } from '@dunx/http';

const app = await HttpFactory.create(AppModule);

await app.listen(3000);`,
  },
  {
    id: 'hero-bunfig',
    label: 'bunfig.toml',
    file: 'bunfig.toml',
    blurb: '',
    code: `preload = ["@dunx/transform/preload"]`,
  },
];

/** Short shell and config snippets used by the start steps and the examples. */
export const SNIPPETS: readonly Sample[] = [
  {
    id: 'step-install',
    label: 'bash',
    file: 'bash',
    blurb: '',
    code: 'bun add @dunx/core @dunx/http @dunx/transform',
  },
  {
    id: 'step-preload',
    label: 'toml',
    file: 'bunfig.toml',
    blurb: '',
    code: '# bunfig.toml\npreload = ["@dunx/transform/preload"]',
  },
  {
    id: 'step-boot',
    label: 'ts',
    file: 'main.ts',
    blurb: '',
    code: 'await (await HttpFactory.create(AppModule)).listen(3000);',
  },
  {
    id: 'run-start',
    label: 'bash',
    file: 'bash',
    blurb: '',
    code: 'bun run start',
  },
  { id: 'run-test', label: 'bash', file: 'bash', blurb: '', code: 'bun test' },
];

/**
 * Annotation-driven DI against dunx, and the line that turns the transform on.
 *
 * Labelled by the pattern rather than by a framework: `@Injectable()` plus a
 * parameter decorator is how Angular, tsyringe and every container built on
 * `reflect-metadata` does it, so naming one of them would be both narrower and
 * less accurate.
 */
export const COMPARISON: readonly Sample[] = [
  {
    id: 'cmp-annotated',
    label: 'Annotation-driven',
    file: 'annotated.ts',
    blurb: '',
    code: `@Injectable()
export class UsersService {
  constructor(
    @Inject(UsersRepository)
    private readonly repo: UsersRepository,
  ) {}
}`,
  },
  {
    id: 'cmp-dunx',
    label: 'dunx',
    file: 'dunx.ts',
    blurb: '',
    code: `export class UsersService {
  constructor(private readonly repo: UsersRepository) {}
}`,
  },
  {
    id: 'cmp-preload',
    label: 'bunfig.toml',
    file: 'bunfig.toml',
    blurb: '',
    code: `preload = ["@dunx/transform/preload"]`,
  },
];

/** Everything the generator pre-highlights, in one place. */
export const ALL_SAMPLES: readonly Sample[] = [
  ...SAMPLES,
  ...HERO_FILES,
  ...SNIPPETS,
  ...COMPARISON,
];

/** shiki language, inferred from the filename the sample is labelled with. */
export const langOf = (file: string): string => {
  if (file.endsWith('.toml')) return 'toml';
  if (file.endsWith('.json')) return 'json';
  if (file === 'bash' || file === 'sh') return 'bash';
  return 'ts';
};
