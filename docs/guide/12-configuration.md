# Configuration

Every app needs to turn a pile of environment strings into a typed object, once,
at boot, and fail loudly if a value is missing. `ConfigModule` in `@dunx/core` is
that, and almost nothing else.

```ts
import { ConfigModule, Module } from '@dunx/core';
import { validate, AppConfigService } from './config.js';

@Module({
  imports: [ConfigModule.forRoot({ validate, as: AppConfigService })],
})
export class AppModule {}
```

## One validation function in place of a schema DSL

`ConfigModule.forRoot` takes exactly one required option:

```ts
interface ConfigModuleOptions<T extends object> {
  validate: (env: ConfigSource) => T | Promise<T>;
  source?: ConfigSource;
  as?: new (values: T) => ConfigService<T>;
}
```

`validate` receives the raw key/value pairs and returns the shaped, typed object.
Whatever it throws is what boot fails with, so throw something whose message says
which keys are wrong.

That is the whole contract. There is no `envFilePath`, no `load: [...]`, no
`validationSchema`, no `expandVariables`.

A schema DSL can only express what its author anticipated; a function expresses
everything. Grouping flat variables into nested objects, deriving one value from
two others, reading a secret out of a file, calling a secret manager: each is
ordinary code inside `validate`, and none needs an option added to dunx.

With zod it is one line:

```ts
const validate = (env: ConfigSource): AppConfig => envSchema.parse(env);
```

A hand-written function works identically and costs no dependency:

```ts
export const validate = (env: ConfigSource): AppConfig => {
  const port = Number(env['PORT'] ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be a port number, got "${env['PORT']}"`);
  }
  return { port };
};
```

dunx does not pick the library, and it does not need to know which one you picked.

## A worked example

This is `examples/full/src/config.ts`, trimmed. Flat variables in, a shaped object
out:

```ts
import { ConfigService, type ConfigSource, LogLevel } from '@dunx/core';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  LOG_LEVEL: z.enum(LogLevel).default(LogLevel.INFO),
  LOG_FILE: z.string().optional(),
  DATABASE_FILE: z.string().default(':memory:'),
  REDIS_URL: z.string().optional(),
});

export interface AppConfig {
  readonly appName: string;
  readonly port: number;
  readonly log: {
    readonly level: LogLevel;
    readonly file: string | undefined;
  };
  readonly database: { readonly file: string };
  readonly redis: { readonly url: string | undefined };
}

export class AppConfigService extends ConfigService<AppConfig> {}

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
    log: { level: value.LOG_LEVEL, file: value.LOG_FILE },
    database: { file: value.DATABASE_FILE },
    redis: { url: value.REDIS_URL },
  };
};
```

Two things worth copying from it. `.default()` is where a value comes from when
the variable is unset, so a clean checkout boots with no `.env` at all. And the
returned shape is nested even though the input is flat, so `config.get('log')`
hands back a group rather than a lone string.

## Reading it

`ConfigService<T>` has three members and no more:

```ts
class ConfigService<T extends object = Record<string, unknown>> {
  readonly values: T;
  get<K extends keyof T>(key: K): T[K];
  getOrThrow<K extends keyof T>(key: K): NonNullable<T[K]>;
}
```

```ts
export class Notifier {
  constructor(private readonly config: AppConfigService) {}

  send(): void {
    const { level } = this.config.get('log');
    const { appName } = this.config.values;
    const url = this.config.getOrThrow('redis').url;
  }
}
```

- `get(key)` returns the value at that key, typed. A key absent from `T` is a
  compile error rather than a runtime `undefined`.
- `getOrThrow(key)` guards the **value** being present. A missing key is already
  a type error, so this catches a declared-but-optional field that is `undefined`
  or `null` at run time. It throws `ConfigError`.
- `values` is the whole validated object, for destructuring or passing on.

There is no dotted-path lookup. The object is fully typed, and
`config.values.db.host` reads better than `config.get('db.host')` while staying
checked.

## Why `as` exists

Declare a subclass and hand it to `as`:

```ts
export class AppConfigService extends ConfigService<AppConfig> {}

ConfigModule.forRoot({ validate, as: AppConfigService });
```

Constructor injection does not strictly need this. `@dunx/transform` records the
bare type name of a constructor parameter and discards the type argument, so
`constructor(private readonly config: ConfigService<AppConfig>)` resolves the
`ConfigService` token while the annotation keeps the precise type.

It breaks in a **factory's `inject` array**, which is why `as` is on the API at
all. `inject: [ConfigService]` resolves to
`ConfigService<Record<string, unknown>>`, the token being a plain runtime value
carrying no type argument to recover.

A factory annotating its parameter as `ConfigService<AppConfig>` is then
**rejected**: parameters are contravariant, so a function demanding the narrower
type is not assignable where one accepting the wider type is expected.

```ts
// Rejected. The token says Record<string, unknown>; the parameter demands AppConfig.
LoggerModule.forRootAsync({
  useFactory: (config: ConfigService<AppConfig>) => ({
    level: config.get('log').level,
  }),
  inject: [ConfigService],
});

// Fine. AppConfigService is a distinct runtime value that is already AppConfig-shaped.
LoggerModule.forRootAsync({
  useFactory: (config: AppConfigService) => ({
    level: config.get('log').level,
  }),
  inject: [AppConfigService],
});
```

A subclass serves as both a precise token and a usable annotation, which is what
the factory case needs. Every `forRootAsync` in dunx exists so options can be read
off config, so `as` comes up almost immediately.

`ConfigService` stays bound to the same instance when `as` is used, so either name
injects. That matters for library code, which only knows the base contract.

## No loader, and no dotenv

Bun loads `.env` and `.env.local` itself, before your code runs. There is
therefore no file loading in `ConfigModule`, no `envFilePath`, and no `dotenv`
dependency. `source` defaults to `Bun.env`, which already carries whatever those
files set.

The precedence and file list are Bun's, documented by Bun, and dunx does not
re-implement or override them.

## Testing

Pass `source` instead of mutating the process environment:

```ts
import { AppFactory, ConfigModule, Module } from '@dunx/core';

const module = ConfigModule.forRoot({
  validate,
  source: { PORT: '8080', LOG_LEVEL: 'debug' },
});
```

Mutating `Bun.env` in a test leaks into every other test in the same process, and
`bun test` runs a file's tests in one process. A literal object is also the only
way to assert that `validate` rejects a bad value, since you cannot unset a
variable that a developer happens to have exported in their shell.

The raw source is bound too, under the `ConfigInput` token, but it is **not**
exported: `validate` is what reads it, and everything downstream reads the shaped
object instead.

## Two things that are absent

**No `isGlobal`.** `ConfigModule.forRoot` is already `global: true`, and exports
`ConfigService` plus whatever `as` names. Configuration is the one thing every
module reads, so a flag to turn that on would only ever be turned on. `ConfigInput`
stays private: it is the raw environment, and nothing outside the module should read
it.

**No `forRootAsync`.** Every other module has one; `ConfigModule` needs none.
`validate` may already return a promise, and the container settles every factory
before the first constructor runs, so an async validation has finished by the
time anything can read it.

`forRootAsync` exists elsewhere to let a factory **inject**, the one thing a
zero-argument function cannot do. `validate` runs before everything and has
nothing to inject.

## Where config is consumed

`forRootAsync({ useFactory, inject })` on `LoggerModule`, `ImagesModule`,
`RedisModule`, `FilesModule`, `DbModule`, `QueueModule` and `AuthModule` all exist
so their options can come off `ConfigService`:

```ts
DbModule.forRootAsync(SyncDatabase, {
  useFactory: (config: AppConfigService) =>
    new SyncSqliteOptions({ schema, filename: config.get('database').file }),
  inject: [AppConfigService],
});
```

See [Logging](./13-logging.md), [Database](./14-database.md),
[Queues](./15-queues.md), [Authentication](./17-authentication.md) and
[Files and images](./18-files-and-images.md) for the rest, and
[Providers](./03-providers.md) for how a factory provider resolves in general.
