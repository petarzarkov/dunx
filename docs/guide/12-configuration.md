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

## A schema, or a function

`forRoot` takes exactly one of the two, and the type enforces it.

```ts
ConfigModule.forRoot({ schema: envSchema, as: AppConfigService });
```

`schema` is any Standard Schema, so zod 4, Valibot and ArkType all work and dunx
names no vendor. A failure fails boot with a `ConfigError` listing every issue and
its path, rather than whatever shape the library throws.

## One validation function in place of a schema DSL

`ConfigModule.forRoot` takes one required option, in either spelling:

```ts
type ConfigModuleOptions<T extends object, S extends object = ConfigSource> = {
  source?: ConfigSource;
  as?: new (values: T) => ConfigService<T>;
} & (
  | { validate: (env: S) => T | Promise<T>; schema?: undefined }
  | { schema: StandardSchemaV1<unknown, T>; validate?: undefined }
);
```

`forRoot` has two signatures, and `files` picks between them: without it `S` is
`ConfigSource`, the flat string map `Bun.env` is; with it `S` is `ConfigValues`,
where a parsed `port: 3000` is already a number. Annotating `ConfigValues` in an
app that passes no files is a compile error rather than a run of empty reads.

`validate` receives the raw key/value pairs and returns the shaped, typed object.
Whatever it throws is what boot fails with, so throw something whose message says
which keys are wrong. `schema` is the same step handed to a Standard Schema
instead, and its issues become a `ConfigError` naming each path.

That is the whole contract, plus `files`. There is no `envFilePath` and no
`expandVariables`.

## Configuration files

`files` reads YAML, TOML and JSON and merges them under the environment:

```ts
ConfigModule.forRoot({
  files: ['application.yml', `application-${Bun.env.NODE_ENV}.yml`],
  schema: configSchema,
  as: AppConfigService,
});
```

`.yml` and `.yaml` go through `Bun.YAML`, `.toml` through `Bun.TOML`, `.json`
through `JSON.parse`. All three are native, so this costs no dependency.

**A relative path resolves against `process.cwd()`, and a missing file is
skipped.** Those two together mean an app started from another directory boots
on defaults rather than failing, so prefer a path anchored to the module:

```ts
import { join } from 'node:path';

const files = [
  join(import.meta.dir, '..', 'application.yml'),
  join(import.meta.dir, '..', `application-${Bun.env.NODE_ENV}.yml`),
];
```

`examples/full` uses that form.

Files are read in the order given and deep-merged, so an overlay overrides only
the keys it names. **A file that does not exist is skipped**, which is what lets
one list cover every environment. A file whose top level is not an object fails
boot naming the file, and so does one that does not parse.

The shape a file is good at is the one a flat variable is bad at:

```yaml
seed:
  users:
    - ada
    - grace
```

`ConfigService.get` reads that back with a dotted path: `config.get('seed.users')`.

### The environment still wins

`Bun.env` is spread over the merged files, so a variable overrides a file key of
the same name. That match is by exact name. There is no convention mapping
`DATABASE__POOLSIZE` onto `database.poolSize`, because that needs a separator, a
case rule and a coercion rule, which is the schema DSL this module does not have.

Override a nested key in `validate`, where it stays visible:

```ts
validate: (src) => schema.parse({
  ...src,
  database: { ...src.database, url: Bun.env.DATABASE_URL ?? src.database.url },
}),
```

Structure belongs in the file, secrets and per-deploy values in the environment.

`validate` receives `ConfigValues` rather than `ConfigSource` once files are in
play: a parsed `port: 3000` is already a number, where `Bun.env` only ever holds
strings.

A schema DSL can only express what its author anticipated; a function expresses
everything. Grouping flat variables into nested objects, deriving one value from
two others, reading a secret out of a file, calling a secret manager: each is
ordinary code inside `validate`, and none needs an option added to dunx.

With zod it is one line, or none at all if the schema is the whole of it:

```ts
const validate = (env: ConfigSource): AppConfig => envSchema.parse(env);
// or: ConfigModule.forRoot({ schema: envSchema, as: AppConfigService })
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
  get(keyOrPath): // the value there, typed
  getOrThrow(keyOrPath): // the same, minus null and undefined
}
```

```ts
export class Notifier {
  constructor(private readonly config: AppConfigService) {}

  send(): void {
    const { level } = this.config.get('log');
    const host = this.config.get('db.host');
    const { appName } = this.config.values;
    const url = this.config.getOrThrow('redis.url');
  }
}
```

- `get(key)` returns the value at that key, typed. A key absent from `T` is a
  compile error rather than a runtime `undefined`.
- `get('a.b')` and `get('a.b.c')` read a path, checked the same way. A step that
  is absent or `null` reads as `undefined` rather than throwing, and the return
  type says so.
- `getOrThrow(...)` guards the **value** being present. A missing key is already
  a type error, so this catches a declared-but-optional field that is `undefined`
  or `null` at run time. It throws `ConfigError` naming the whole path.
- `values` is the whole validated object, for destructuring or passing on.

Paths stop at three segments. `config.values.a.b.c.d` is what reaches past them.
Each depth is a separate overload rather than one recursive type: a conditional
type over `T` anywhere on this class makes its variance unmeasurable, and
`app.get(ConfigService)` then stops compiling. A top-level key that itself
contains a dot is read whole, so it keeps winning over a path that spells it.

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

It breaks in a **factory's `inject` array**, and `as` exists on the API because
of that gap. `inject: [ConfigService]` resolves to
`ConfigService<Record<string, unknown>>`: the token is a plain runtime value,
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

A subclass serves as both a precise token and a usable annotation - exactly what
the factory case needs. Every `forRootAsync` in dunx exists so options can be
read off config, so `as` comes up almost immediately.

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

## No `isGlobal`, no `forRootAsync`

`ConfigModule.forRoot` is already `global: true`, and exports `ConfigService`
plus whatever `as` names. Configuration is the one thing every module reads, so
a flag to turn that on would only ever be turned on. `ConfigInput` stays
private: it is the raw environment, and nothing outside the module should read
it.

Every other module offers `forRootAsync`; `ConfigModule` needs none. `validate`
may already return a promise, and the container settles every factory before the
first constructor runs, so an async validation has finished by the time anything
can read it.

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

## The HTTP server's own settings

`HttpFactory.create(root, options)` builds the container, so its `options` argument
is assembled before `ConfigService` exists. `HttpOptionsProvider` is the same
settings as a provider, which can inject:

```ts
export class AppHttpOptions extends HttpOptionsProvider {
  constructor(private readonly config: AppConfigService) {
    super();
  }

  override get prefix(): string {
    return this.config.get('prefix');
  }
}

@Module({
  providers: [provide(HttpOptionsProvider, { useClass: AppHttpOptions })],
  exports: [HttpOptionsProvider],
})
export class HttpConfigModule {}
```

Every member has a default, so a subclass overrides only what differs. Anything
passed to `create()` wins field by field, and `setGlobalPrefix`, `enableCors` and
`set` still work and win over both, since they run after construction.

Override a field with a field and a getter with a getter - TypeScript rejects the
other pairing (`TS2611`, `TS2610`). To derive a field from config, declare
`override trustProxy: boolean` and assign it in the constructor.

See [Upgrading](./23-upgrading.md) for what each imperative call maps to.
