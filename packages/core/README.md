# @dunx/core

The dependency injection container, modules, lifecycle, configuration, and the
`Logger` and `RequestContext` contracts. **Zero dependencies** - that is a
constraint rather than a coincidence: it lets `@dunx/http` inject a logger
without pulling a logging implementation in behind it.

## Install

```bash
bun add @dunx/core
```

## Dependency injection

Constructor injection, with no annotation of any kind:

```ts
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}
}
```

No `@Injectable`, no `@Inject`, no `reflect-metadata`, no `experimentalDecorators`.
`@dunx/transform` reads each class's constructor parameter types at load time and
records them on the class; the container resolves them before calling `new`. Apps
opt in with one line in `bunfig.toml`:

```toml
preload = ["@dunx/transform/preload"]
```

A parameter whose type is erased - an interface, a primitive, a union, a type-only
import - becomes a **boot error naming that parameter** rather than a silent `undefined`.
That is the wart `emitDecoratorMetadata` has and this does not.

`inject()` in a field initializer is the escape hatch for a value with no
constructor parameter to hang off. Both may be used in one class.

## Modules

```ts
@Module({
  imports: [DatabaseModule],
  controllers: [UsersController],
  providers: [UsersService, provide(Clock, { useValue: systemClock })],
})
export class UsersModule {}

const app = await AppFactory.create(UsersModule);
app.enableShutdownHooks();
```

**Every module is a scope.** `providers` are private to the module that
declares them, and `exports` is the list an importer may resolve - a module
that exports nothing exports nothing. `exports` also accepts a `ModuleRef`,
which re-exports whatever that module exports, so `DatabaseModule` can pass a
handle on and a feature module imports _it_ rather than `@dunx/infra/db`.

`global: true` publishes a module's exports to every scope with no import
needed, which `ConfigModule` and `LoggerModule` use.

For a token requested while constructing a provider in module `M`: `M`'s own
providers, then the exports of what `M` imports, then the global scope. **Local
shadows imported**, the per-module rebinding this exists to allow. The
instance cache keys on the binding rather than the token, so two modules that
each declare one class hold two instances.

Visibility is flattened once at boot into one `Map` per scope, so resolution
stays a single `Map.get` and the cost of the import walk lands on boot.

The same token twice **in one module** is an error. Two modules binding one token
is legal and silent. An importer seeing one token from two imports takes the
**last** and **warns**, naming both - on `App.warnings` rather than in a log,
because core has no logger and the caller knows what level it belongs at.

Resolution is **eager**, and async factories are settled before any constructor
runs, so there is no `forRootAsync` for asynchrony alone. Where a module
does have one (`LoggerModule`, `ImagesModule`, `RedisModule`, `FilesModule`,
`DbModule`) it is for the other thing a zero-argument function cannot do: **inject**.

`onInit` runs in dependency order, `onShutdown` in reverse - so a service drains
before the database it holds.

`enableShutdownHooks()` drains on `SIGTERM`/`SIGINT` and then **ends the
process**. Draining is not exiting: one handle that outlives teardown leaves a
drained, idle process alive until `SIGKILL`, and it is usually a third party's
handle rather than yours.

The forced exit is an `unref()`d timer, so it cannot itself hold the runtime
open - a process with nothing pending exits immediately and waits for nothing,
and the pause is only ever spent on one that would have hung. It logs a line
when it fires, because that means something leaked.

`{ exitAfterMs: false }` opts out, for an app embedded in a process it does not
own - and for **a test that fires a signal at its own process**, where the forced
exit would otherwise land mid-run:

```ts
app.enableShutdownHooks(['SIGTERM'], { exitAfterMs: false });
```

`AppFactory.create(root, { overrides })` takes registrations that **replace** a
binding for the same token, in place, in **every scope that holds it** - so a
test stubbing `Logger` does not have to know how many modules bind it.

An override for a token nobody binds is an error, and the discarded provider is
never instantiated (its `useFactory` never runs). `@dunx/testing` is what
consumes it; there is no reason to reach for it directly in application code.

## Configuration

One validation function. Not a schema DSL, and not a second place to declare
defaults:

```ts
const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  DATABASE_URL: z.string(),
});

export interface AppConfig {
  port: number;
  database: { url: string };
}

export const validate = (env: ConfigSource): AppConfig => {
  const value = envSchema.parse(env);
  return { port: value.PORT, database: { url: value.DATABASE_URL } };
};

export class AppConfigService extends ConfigService<AppConfig> {}

@Module({ imports: [ConfigModule.forRoot({ validate, as: AppConfigService })] })
export class AppModule {}
```

```ts
export class Server {
  constructor(private readonly config: AppConfigService) {}

  start(): void {
    const { port } = this.config.values;
    const url = this.config.get('database').url;
  }
}
```

dunx does not pick the validator. zod above; a hand-written function that throws
works identically and costs no dependency. Whatever it throws is what boot fails
with, so raise an error whose message names the offending keys.

Bun already loads `.env` and `.env.local`, so there is no loader here and no
`dotenv`. The source defaults to `Bun.env`; pass `source` in a test rather than
mutating the process environment.

**Why the subclass.** `inject: [ConfigService]` resolves to
`ConfigService<Record<string, unknown>>` - the token carries no type argument
to recover, and parameters are contravariant, so a factory annotating
`ConfigService<AppConfig>` is rejected.

A subclass is a distinct runtime value, so it is both a precise token and a
usable annotation. `ConfigService` stays bound to the same instance, so library
code that only knows the base still resolves.

## Always-bound contracts

Two tokens always resolve, whether or not anything bound them. The default is
offered *after* every module's registrations, so a module binding either one wins.

| Token            | Default               | Replaced by                            |
| ---------------- | --------------------- | -------------------------------------- |
| `Logger`         | `ConsoleLogger`       | `LoggerModule` → `@arkv/logger`        |
| `RequestContext` | `AsyncRequestContext` | `LoggerModule` → arkv's `ContextStore` |

They exist so `@dunx/http` can log every request in an app that imported no logging
module at all. Neither default reaches for a dependency: `ConsoleLogger` writes one
JSON line per entry, and `AsyncRequestContext` is `AsyncLocalStorage`, a Node
built-in Bun implements natively.

`ConsoleLogger` does **not** sanitize, mask, rotate or colour. That is the whole
argument for swapping in `@dunx/infra/logger`, which is one import.

#### Entries at `info` and below are batched

One `console.log` per entry is one `write(2)` per entry, and on `internal/bench`'s
logging harness that was the single largest component of request logging - dearer
than the `JSON.stringify` that produced the line. `ConsoleLogger` concatenates those
entries and writes them **once per event-loop turn**, which takes the write below
what the harness can measure.

The trade is real: a line still in the buffer is lost if the process dies without
unwinding - `SIGKILL`, an OOM kill, a segfault. What bounds it:

- **`warn`, `error` and `fatal` are never buffered.** They are written immediately
  and flush everything queued behind them, so the entries you go looking for after a
  crash, and everything leading up to them, were never held back.
- The window is one event-loop turn.
- `logger.flush()` is public; `onShutdown()` calls it, so the container flushes on a
  graceful stop, and `process.on('exit')` catches the rest.
- `new ConsoleLogger(context, level, false)` writes every entry as it happens.

```ts
provide(Logger, {
  useFactory: (context: RequestContext) =>
    new ConsoleLogger(context, 'info', false),
  inject: [RequestContext] as const,
});
```

### The contracts

`Logger` is an `abstract class` rather than an interface: the compiler
records constructor parameter *types*, and an interface has no runtime value to
record, so it would be a boot error at the injection site.

```ts
export class Users {
  constructor(private readonly logger: Logger) {}

  create(email: string): void {
    this.logger.info('user created', { email });
  }
}
```

Six levels - `verbose`, `debug`, `info`, `warn`, `error`, `fatal` - each taking a
message plus extras, a plain object merged into the entry, or an `Error`. `log` is
a deprecated alias for `info`; it emits `"level":"info"` either way and exists
because a third-party `LoggerService` interface mandates the name.

`RequestContext` is request-scoped fields propagated across async boundaries -
`getContext`, `updateContext`, `runWithContext`. `@arkv/logger`'s `ContextStore`
satisfies it structurally, so `@dunx/infra/logger` binds one to the other with no
adapter class, and the logger then reads the very store the HTTP middleware wrote.

Nested scopes merge: an inner `runWithContext({ userId })` inherits the outer
`requestId` rather than replacing it. Pass `{ inherit: false }` for a scope that
must start clean, such as a detached background job.

## License

[MIT](../../LICENSE)
