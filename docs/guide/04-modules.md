# Modules

A module is a **scope**: a named set of registrations that are private to it, plus a
list of tokens it makes visible to whoever imports it. That sentence is the whole
model.

```ts
import { Module } from '@dunx/core';

@Module({
  imports: [DatabaseModule],
  controllers: [UsersController],
  providers: [UsersService, UsersRepository],
  exports: [UsersService],
})
export class UsersModule {}
```

`UsersRepository` is not on the `exports` line, so nothing outside `UsersModule` can
resolve it. That is the boundary, and everything else on this page follows from it.

## `@Module` is a marker

The decorator writes its options onto the class as a
`Symbol.for('dunx.module')` property and returns the class. The class is never
instantiated. It has no constructor to inject into, no lifecycle hooks, and no
runtime behaviour at all. It exists to give a module a name for error messages.

A class handed to `AppFactory.create` or to `imports` without the decorator is a
boot error:

```
UsersModule is not a dunx module. Decorate it with @Module({ providers: [...] }),
or import a configured one from a static factory such as UsersModule.forRoot().
```

Options are read with `Object.hasOwn`, so **subclassing a module does not inherit
its bindings**. `class TestUsersModule extends UsersModule {}` throws the message
above rather than quietly registering `UsersModule`'s providers. Constructor
dependencies follow the opposite rule, where a subclass does inherit;
[Providers](./03-providers.md) covers both.

## The five lists

| Key           | Contains                                                         |
| ------------- | ---------------------------------------------------------------- |
| `imports`     | Modules whose `exports` this one may resolve                     |
| `controllers` | Classes whose constructed instances are scanned for routes       |
| `providers`   | Everything else, private to this module unless exported          |
| `exports`     | The tokens - or whole modules - an importer may resolve          |
| `middleware`  | Middleware for **this module's** routes, resolved from its scope |

plus one flag, `global: true`, which publishes this module's `exports` app-wide.

`controllers` and `providers` are registered **identically**. Core constructs both
the same way; the split exists so an HTTP adapter can ask which instances to scan.
The only behavioural consequence: a class in `controllers` that declares no
routes is a boot error telling you to move it to `providers`.

An entry in either list is a bare class, which binds it to itself, or a
`Registration` from `provide()`. See [Providers](./03-providers.md) for the shapes
of the latter.

## How a token resolves

For a provider declared by module `M`, asking for a token:

1. `M`'s own `providers` and `controllers`.
2. The `exports` of the modules `M` imports, transitively through re-exports.
3. The global scope - the `exports` of every module marked `global: true`.
4. If the token is a **class** nothing visible binds, it self-binds into `M`'s scope.
5. Otherwise it is a boot error, and the message names the fix.

**Local shadows imported.** If `M` declares a token an import also exports, `M`'s
binding wins. This per-module rebinding is why the scope boundary exists: a
`Clock` bound one way in billing and another way in reporting costs two lines and
one token.

Visibility is flattened **once, at boot**, into one map per module. An import chain is
never walked per lookup, so resolution stays the single `Map.get` it was before scopes
existed, and the whole graph for `examples/full` - 16 modules, every feature - builds
in a median 1.7 ms.

## `exports` is the public surface

**Absent means nothing is exported.** A module with providers and no `exports` is
fully private.

`exports` accepts a token or a **module reference**. A module reference
re-exports whatever that module exports, which is how a facade works:

```ts
@Module({
  imports: [DbModule, RedisModule],
  exports: [DbModule, RedisModule],
})
export class InfraModule {}
```

An importer of `InfraModule` sees the database and the cache without naming either.
Re-export cycles - `A` exports `B` and `B` exports `A` - are legal and terminate: an
export set is a union, union only grows, so the sets are computed to a fixed point
rather than by recursion. There is no `forwardRef` for this or for anything else.

Exporting a token no module in reach provides is a boot error, raised where the
mistake is rather than in the module that later fails to resolve it:

```
Module "ReportsModule" exports UsersRepository, but does not declare it and no
module it imports exports it. Add it to this module's providers, or import the
module that provides it.
```

### `global: true`

A global module's `exports` land in one global scope visible from every other scope,
with no import needed. Its private providers stay private.

```ts
@Module({ providers: [Clock], exports: [Clock], global: true })
export class ClockModule {}
```

A **field**, with no `@Global()` decorator beside it. A `DynamicModule` would
need the field anyway, so a decorator would be a second spelling for one idea.
`ConfigModule.forRoot` sets it, configuration being the one thing every module
reads.

Global is the weakest source: an import beats it, and a local declaration beats both.

### The error is the feature

`exports` reintroduces the most complained-about error in the Nest ecosystem, so dunx
answers it from the whole graph, which it has at boot:

```
Cannot resolve UsersRepository for ReportsService in module "ReportsModule".
"UsersModule" declares it and "ReportsModule" imports that module, but it does not
export UsersRepository. Add UsersRepository to that module's exports, or move the
provider into "ReportsModule".
```

A token declared by a module you do **not** import says so instead, and names the
`imports` line to add. A token nothing declares says that, rather than blaming the
nearest module.

## Module middleware

A module can put middleware in front of the routes its own controllers declare:

```ts
@Module({
  controllers: [ReportsController],
  providers: [ReportsService, TenantPolicy, TenantGuard],
  middleware: [TenantGuard],
  exports: [ReportsService],
})
export class ReportsModule {}
```

`TenantGuard` is resolved from `ReportsModule`'s scope, so it injects `TenantPolicy`,
which no other module can see. There is no `forRoutes()` and no path matching: a
module already owns its controllers, so the routes it applies to are the routes those
controllers declare.

**There is no inheritance.** A module's middleware applies to its own controllers and
to nothing it imports, so importing a module never changes the request path of the
importer's routes. Middleware that really is app-wide stays app-wide, in
`HttpFactory.create(root, { middleware })`.

One field rather than `middleware` plus `guards`, because a guard here is middleware
that throws. [Middleware and guards](./08-middleware-and-guards.md) has the full chain.

## Two modules binding one token

Under scopes this is legal - it is the rebinding the boundary exists to allow - so the
old blanket duplicate check split into one error and two warnings:

| Case                                                   | What happens                        |
| ------------------------------------------------------ | ----------------------------------- |
| The same token twice **in one module**                 | boot error                          |
| Two **different** modules each declaring it            | legal and silent: two instances     |
| A module declaring what an import also exports to it   | legal, and **warned once** at boot  |
| A module importing it from **two** modules that differ | legal, last import wins, and warned |

The warnings are on `app.warnings` and logged at boot. They exist because "my
override is not being used" is otherwise unexplainable; Nest is silent here and it
costs people hours. A diamond - two imports that re-export the _same_ binding - stays
silent, because there is only one answer.

```
Module "ReportsModule" declares Clock, which module "ClockModule" also exports to
it. The local one wins, so these are two separate instances. Remove one, or ignore
this if the rebinding is deliberate.
```

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
two modules both import `SharedModule`, gives one scope that both see. A cycle in
the import graph terminates instead of recursing, and is legal - a module cycle is
not a provider cycle, and only the second is an error.

**Deduplication is per reference rather than per module identity.** A bare class
is one reference however many modules import it, and the same `DynamicModule` _object_
imported twice is likewise one reference. Two _different_ configurations of the
same module are two objects, and each gets **its own scope**:

```ts
@Module({
  imports: [
    StoreModule.forRoot({ bucket: 'uploads' }),
    StoreModule.forRoot({ bucket: 'reports' }),
  ],
})
class Root {}
```

Two scopes, two `Options` bindings, two `Store` instances. Under the flat
container this was a duplicate-binding error. The importer above sees `Store`
exported from both, so it is warned that the last one wins:

```
Module "Root" imports Store from both "StoreModule" and "StoreModule". The last
import wins, so these are two separate instances. Import one, or declare it here.
```

Import each configuration from the consumer that needs it. One module importing
both can only see one of them.

**A `DynamicModule` unions its options with its own class's decorator.** If
`Root.forRoot()` returns `{ module: Root, providers: [...] }` and `Root` is also
decorated with `@Module({ providers: [...] })`, both sets are collected. The
dynamic options do not replace the declared ones:

```ts
@Module({ providers: [provide(A, { useValue: 'from the decorator' })] })
class Root {
  static dyn(): DynamicModule {
    return {
      module: Root,
      providers: [provide(B, { useValue: 'from the static' })],
    };
  }
}

// Both A and B resolve.
await AppFactory.create(Root.dyn());
```

That matches the convention, and it is the reason the warning above fires most often:
a `ConfigModule.forRoot()` in the decorator's `imports` and another in the static's
is two configurations of one module. Put it in one place or the other.

## Dynamic modules

A `DynamicModule` is a plain object: a module class for identity, plus the same
option lists.

```ts
export interface DynamicModule extends ModuleOptions {
  readonly module: ModuleClass;
}
```

`ModuleOptions` is the same five lists plus `global`, so a configured module exports,
goes global and declares middleware exactly as a decorated one does.

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
      exports: [Mailer],
    };
  }
}
```

```ts
@Module({
  imports: [
    MailerModule.forRoot(new MailerOptions(key, 'noreply@example.com')),
  ],
})
export class AppModule {}
```

`exports: [Mailer]` is required for an importer to resolve it. `MailerOptions`
stays private; an importer has no business resolving another module's options.

The `module` field is the identity. It is what error messages name and what lets
traversal tell two configurations of one module apart. Registrations from a
configured module are **merged** with whatever the class's own `@Module` decorator
declares, so a module can have a static core plus configured extras. A class used
only through its factory, like `MailerModule` above, needs no decorator at all.

## `forRoot` versus `forRootAsync`

The `forRootAsync` pattern exists to build a module's options from other injected
providers, asynchronously. It needs a distinct mechanism because a container resolves
lazily and has to defer.

**dunx has no such mechanism, and does not need one.** Resolution is eager and
every async factory is settled before any constructor runs, so "options computed
from another provider" is already just a provider:

```ts
import {
  provide,
  type AsyncModuleConfig,
  type Deps,
  type DynamicModule,
} from '@dunx/core';

export class MailerModule {
  static forRoot(options: MailerOptions): DynamicModule {
    return {
      module: MailerModule,
      providers: [provide(MailerOptions, { useValue: options }), Mailer],
      exports: [Mailer],
    };
  }

  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<MailerOptions, D>,
  ): DynamicModule {
    return {
      module: MailerModule,
      ...(config.imports === undefined ? {} : { imports: config.imports }),
      providers: [provide(MailerOptions, config), Mailer],
      exports: [Mailer],
    };
  }
}
```

Two lines differ. There is no deferred-options token, no `ASYNC_OPTIONS_TYPE`, no
second code path in the module, and the container does not know the difference.

`AsyncModuleConfig` is `FactoryProvider` plus an `imports` field, and that field is
there because of scoping: the factory is **written** at the call site but **runs** in
the configured module's scope, so whatever it injects has to be visible from there.
`ConfigModule` is `global: true`, so the common case needs nothing; a factory reading
some other module's export passes `imports: [ThatModule]`.

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

One shipped variant takes an extra first argument. Check it before writing your
own:

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

The token comes first because _which_ drizzle class the database binds to only
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

**One validation function in place of a schema DSL.** `validate` receives the raw source
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
`ConfigService<AppConfig>` is rejected: parameters are contravariant and the
token carries no type argument to recover.

A subclass is a distinct runtime value, so it serves as both a precise token and
a usable constructor annotation. `ConfigService` stays bound to the same instance
through an alias provider, so library code that knows only the base contract
still injects.

There is no `isGlobal` to pass, because `ConfigModule.forRoot` already sets
`global: true` and exports both `ConfigService` and whatever `as` names.
Configuration is the one thing every module reads, so making each of them import it
would be ceremony with no boundary behind it. And there is no
`ConfigModule.forRootAsync`, because eager resolution settles an async `validate`
before any constructor runs.

## The root module, and what wraps it

`AppFactory.create(root)` takes a module class or a `DynamicModule`. So does
`HttpFactory.create(root)`, which wraps your root in an internal module of its own
in order to bind `PubSub` and, unless you turned it off,
`RequestLoggingMiddleware`. That wrapper is why those are injectable in an
application that imported nothing.

The wrapper is invisible to the boundary. Global middleware, `@UseGuards` classes
and an error filter all resolve as **your** root sees them, so listing a guard in
`HttpFactory.create` never obliges your root to re-export it. Anything named
there is found in the one module that declares it, and two modules declaring it
is an error. `app.get()` resolves the same way.

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
