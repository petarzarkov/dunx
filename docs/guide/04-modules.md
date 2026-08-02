# Modules

A module is a named list of registrations and a list of other modules to include.
That sentence is the whole model, and it is shorter than Nest's on purpose.

```ts
import { Module } from '@dunx/core';

@Module({
  imports: [DatabaseModule],
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
})
export class UsersModule {}
```

The syntax is Nest's. The semantics are not, and that distinction is the most
important thing on this page.

## `@Module` is a marker

The decorator writes its options onto the class as a
`Symbol.for('dunx.module')` property and returns the class. The class is never
instantiated. It has no constructor to inject into, no lifecycle hooks, and no
runtime behaviour at all: it exists so that a module has a name, which is what
error messages use.

A class handed to `AppFactory.create` or to `imports` without the decorator is a
boot error:

```
UsersModule is not a dunx module. Decorate it with @Module({ providers: [...] }),
or import a configured one from a static factory such as UsersModule.forRoot().
```

Options are read with `Object.hasOwn`, so **subclassing a module does not inherit
its bindings**. `class TestUsersModule extends UsersModule {}` throws the message
above rather than quietly registering `UsersModule`'s providers. Note that this is
the opposite of the rule constructor dependencies use, where a subclass
deliberately does inherit; the reasoning for both is in
[Providers](./03-providers.md).

## The three lists

| Key           | Contains                                                    |
| ------------- | ------------------------------------------------------------ |
| `imports`     | Other modules to pull in. Traversal only                    |
| `controllers` | Classes whose constructed instances are scanned for routes  |
| `providers`   | Everything else                                             |

`controllers` and `providers` are registered **identically**. Core constructs both
the same way; the split exists so an HTTP adapter can ask which instances to scan.
A class in `controllers` that declares no routes is a boot error telling you to
move it to `providers`, which is the only behavioural consequence.

An entry in either list is a bare class, which binds it to itself, or a
`Registration` from `provide()`. See [Providers](./03-providers.md) for the shapes
of the latter.

## There is no `exports`

`imports` pulls a module's registrations into the same flat container. It does not
create a visibility boundary. There is no `exports` list, no `isGlobal`, and
therefore no "provider is not exported from module X" error, because there is
nothing to export from.

This is the largest deliberate divergence from Nest and it is worth being blunt
about what it costs.

**What you lose.** Per-module rebinding. A `LOGGER` token bound to one
implementation in billing and a different one in reporting cannot be expressed.
One token has exactly one binding. The workaround is two tokens, and if that is
unacceptable for your architecture then Nest's module system is a real feature
dunx does not have.

**What you keep, elsewhere.** The encapsulation Nest gives you is largely
recoverable outside the container. Reaching `BillingService` requires a value
import of `BillingService`, so cross-domain coupling is already visible in the
import graph and enforceable with a lint boundary rule at zero runtime cost.

**What you get.** Resolution across a module boundary is not a concept. Any
provider anywhere in the graph is injectable from anywhere else, with no
re-export, no `forwardRef` between modules, and no `Module X is trying to
inject Y` error to debug. A module is a unit of organisation and of ordering, not
a unit of scope.

Because the container is flat, two modules binding the same token is a real
hazard, and it is caught rather than resolved silently. See
[Duplicate bindings](./03-providers.md#duplicate-bindings).

## Traversal, ordering and deduplication

`AppFactory.create(RootModule)` flattens the import graph depth-first, visiting
**imports before importers**, so a module's dependencies register before it does.
Each reference is visited once.

```ts
@Module({
  imports: [
    ConfigModule.forRoot({ validate, as: AppConfigService }),
    LoggerModule.forRootAsync({ useFactory, inject: [AppConfigService] }),
    DatabaseModule,
    UsersModule,
    HealthModule,
  ],
})
export class AppModule {}
```

Read that list top to bottom as construction order and bottom to top as shutdown
order. Config and the logger are built first and torn down last; the database
outlives every feature that queries it. That is the practical reason to care about
`imports` order at all, and the reason a long-running service should put its
infrastructure at the top.

To be precise: within the container, a dependency is always constructed before its
dependent regardless of where either was registered, because resolution recurses.
Registration order decides the rest, which is everything not pinned by a
dependency edge. Teardown reverses construction completion order exactly.

Visiting each reference once is what makes two other shapes work. A diamond, where
two modules both import `SharedModule`, registers `SharedModule` once rather than
tripping the duplicate-binding check. A cycle in the import graph terminates
instead of recursing.

**Deduplication is per reference, not per module identity.** A bare class is one
reference however many modules import it. The same `DynamicModule` *object*
imported twice is likewise one reference. But two *different* configurations of
the same module are two objects, and both register:

```
Duplicate binding for Options: bound by module "StoreModule" and module "StoreModule".
```

That is deliberate, not a bug. Last-wins would have been silent and first-wins
would depend on traversal order, so neither is something a reader could predict.
Both configurations register and the conflict surfaces, reusing the flat
container's existing rule instead of adding a second one.

## Dynamic modules

A `DynamicModule` is a plain object: a module class for identity, plus the same
three option lists.

```ts
export interface DynamicModule {
  readonly module: ModuleClass;
  readonly imports?: readonly ModuleRef[];
  readonly controllers?: readonly Ctor<unknown>[];
  readonly providers?: readonly ProviderEntry[];
}
```

The convention is a static factory named `forRoot`:

```ts
import { provide, type DynamicModule } from '@dunx/core';

export class MailerOptions {
  constructor(
    readonly apiKey: string,
    readonly from: string,
  ) {}
}

export class Mailer {
  constructor(private readonly options: MailerOptions) {}

  send(to: string, body: string): Promise<void> {
    return post(this.options.apiKey, this.options.from, to, body);
  }
}

export class MailerModule {
  static forRoot(options: MailerOptions): DynamicModule {
    return {
      module: MailerModule,
      providers: [provide(MailerOptions, { useValue: options }), Mailer],
    };
  }
}
```

```ts
@Module({
  imports: [MailerModule.forRoot(new MailerOptions(key, 'noreply@example.com'))],
})
export class AppModule {}
```

The `module` field is the identity. It is what error messages name and what lets
traversal tell two configurations of one module apart. Registrations from a
configured module are **merged** with whatever the class's own `@Module` decorator
declares, so a module can have a static core plus configured extras. A class used
only through its factory, like `MailerModule` above, needs no decorator at all.

## `forRoot` versus `forRootAsync`

Nest's `forRootAsync` exists to build a module's options from other injected
providers, asynchronously. It needs a distinct mechanism because Nest resolves
lazily and has to defer.

**dunx has no such mechanism, and does not need one.** Resolution is eager and
every async factory is settled before any constructor runs, so "options computed
from another provider" is already just a provider:

```ts
import { provide, type Deps, type DynamicModule, type FactoryProvider } from '@dunx/core';

export class MailerModule {
  static forRoot(options: MailerOptions): DynamicModule {
    return {
      module: MailerModule,
      providers: [provide(MailerOptions, { useValue: options }), Mailer],
    };
  }

  static forRootAsync<const D extends Deps>(
    factory: FactoryProvider<MailerOptions, D>,
  ): DynamicModule {
    return {
      module: MailerModule,
      providers: [provide(MailerOptions, factory), Mailer],
    };
  }
}
```

Two lines differ. There is no deferred-options token, no `ASYNC_OPTIONS_TYPE`, no
second code path in the module, and the container does not know the difference.

So why does the name exist at all? Because reading options off `ConfigService` is
the one thing a zero-argument options object cannot do, and `forRootAsync` is the
conventional name for that. It ships on `LoggerModule`, `ImagesModule`,
`RedisModule`, `FilesModule` and `DbModule`:

```ts
@Module({
  imports: [
    ConfigModule.forRoot({ validate, as: AppConfigService }),
    RedisModule.forRootAsync({
      useFactory: (config: AppConfigService) => {
        const { url } = config.get('redis');
        return {
          ...(url === undefined ? {} : { url }),
          connectionTimeout: 500,
          maxRetries: 0,
        };
      },
      inject: [AppConfigService] as const,
    }),
  ],
})
export class InfraModule {}
```

The `useFactory` may be `async`. By the time any repository's constructor runs,
the connection is open and its options applied. That guarantee is what removes the
second mechanism.

One shipped variant takes an extra first argument, and the reason is worth knowing
if you write your own:

```ts
DbModule.forRootAsync(SyncDatabase, {
  useFactory: (config: AppConfigService) =>
    new SyncSqliteOptions({
      schema,
      filename: config.get('database').file,
      pragmas: ['foreign_keys = ON'],
    }),
  inject: [AppConfigService],
});
```

The token comes first because *which* drizzle class the database binds to only
becomes knowable once the options factory has run, which is too late to register a
provider under it. If your own module's token depends on its own options, you have
the same problem and the same fix.

## `ConfigModule`, end to end

`ConfigModule` is the dynamic module most applications import first, and it shows
every idea on this page at once.

```ts
// src/config.ts
import { ConfigService, type ConfigSource } from '@dunx/core';
import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  DATABASE_FILE: z.string().default(':memory:'),
  CORS_ORIGIN: z.string().default('https://example.com'),
});

export interface AppConfig {
  readonly port: number;
  readonly corsOrigin: string;
  readonly database: { readonly file: string };
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
    port: value.PORT,
    corsOrigin: value.CORS_ORIGIN,
    database: { file: value.DATABASE_FILE },
  };
};
```

```ts
@Module({
  imports: [ConfigModule.forRoot({ validate, as: AppConfigService })],
})
export class AppModule {}
```

Four things to take from it.

**One validation function, not a schema DSL.** `validate` receives the raw source
and returns the shaped, typed object. Whatever it throws is what boot fails with,
so throw something whose message names the wrong keys. zod is
`validate: (env) => schema.parse(env)`. A hand-written function works identically
and costs no dependency. dunx does not pick the library.

**Flat variables in, a shaped object out.** `config.get('database')` hands back a
group rather than a lone string, because the validation step is where flattening
stops. Nothing downstream reads `process.env`.

**There is no loader and no `dotenv`.** The source defaults to `Bun.env`, which
already carries `.env` and `.env.local` because Bun loads them itself. In a test,
pass `source` rather than mutating the process environment:

```ts
ConfigModule.forRoot({ validate, source: { PORT: '0' } });
```

**`as` is not optional in practice.** Declare a subclass and hand it over:

```ts
export class AppConfigService extends ConfigService<AppConfig> {}
```

Without it, `inject: [ConfigService]` resolves to
`ConfigService<Record<string, unknown>>` and a factory annotating
`ConfigService<AppConfig>` is rejected, because parameters are contravariant and
the token carries no type argument to recover. A subclass is a distinct runtime
value, so it is both a precise token and a usable constructor annotation.
`ConfigService` stays bound to the same instance through an alias provider, so
library code that only knows the base contract still injects.

There is no `isGlobal` to pass. The container is flat, so one registration is
visible everywhere. And there is no `ConfigModule.forRootAsync`, because eager
resolution settles an async `validate` before any constructor runs.

## The root module, and what wraps it

`AppFactory.create(root)` takes a module class or a `DynamicModule`. So does
`HttpFactory.create(root)`, which wraps your root in an internal module of its own
in order to bind `PubSub` and, unless you turned it off,
`RequestLoggingMiddleware`. That wrapper is why those are injectable in an
application that imported nothing.

The same technique is available to you. `OpenApiModule.forRoot({ root: AppModule, ... })`
wraps the root it documents, so `create()` is still handed one module reference and
the generated document's own routes are discovered with the rest:

```ts
const app = await HttpFactory.create(
  OpenApiModule.forRoot({
    title: 'my-api',
    version: '0.1.0',
    root: AppModule,
  }),
);
```

`@dunx/testing` does the same thing for a different reason: `createTestApp({ modules })`
makes the modules under test the `imports` of one synthetic root, so no fixture
module has to be written by hand.

## Next

[Controllers](./05-controllers.md) for what a class in `controllers` does with its
routes.
