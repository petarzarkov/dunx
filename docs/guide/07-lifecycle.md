# Lifecycle

One lifetime, three hooks, eager boot. All of it is `@dunx/core` and none of it
needs `@dunx/http`.

## Provider lifetime

Every provider is a singleton **within the module scope that declares it**.

```ts
@Module({ providers: [UsersService] })
export class UsersModule {}
```

`UsersService` is constructed once. Everything resolving from `UsersModule`'s
scope receives that instance.

| Nest              | dunx                         |
| ----------------- | ---------------------------- |
| `Scope.DEFAULT`   | the only lifetime            |
| `Scope.REQUEST`   | absent, and will stay absent |
| `Scope.TRANSIENT` | absent, and will stay absent |

Two modules that each list the same class in `providers` get two instances, one
per scope. [Modules](./04-modules.md) covers when that is what you want.

### Per-request state

Request-scoped DI was measured and turned down: it is a container's largest
source of per-request cost and complexity. Two replacements cover what it was
used for.

**Correlation data** goes through `RequestContext`, an `AsyncLocalStorage` that
never touches the container:

```ts
export class OrdersService {
  constructor(
    private readonly context: RequestContext,
    private readonly logger: Logger,
  ) {}

  place(order: Order) {
    // traceId was set by RequestLoggingMiddleware, on the way in
    const { traceId } = this.context.getContext();
    this.logger.info('placing', { traceId });
  }
}
```

**Everything else** is a parameter:

```ts
@Post('/orders', { body: OrderSchema })
create(req: BunRequest, body: Order) {
  return this.orders.place(body, req.headers.get('x-tenant'));
}
```

Reasoning and the measurement: [architecture/dependency-injection.md](../architecture/dependency-injection.md).

## Boot

`AppFactory.create()` builds the scope graph, instantiates **every** provider,
awaits **every** async factory, then runs `onInit`. It returns a live app; there
is no separate `init()` call.

```ts
const app = await AppFactory.create(AppModule);
```

A wiring error therefore surfaces at boot rather than on the first request that
happens to hit the broken route.

| Stage | What runs                                                         |
| ----- | ----------------------------------------------------------------- |
| 1     | `buildScopes` walks the import graph                              |
| 2     | overrides replace matching bindings in every scope that holds one |
| 3     | every provider is constructed, dependencies first                 |
| 4     | `onInit()` on each instance, in construction order                |
| 5     | shadowing and ambiguous-import warnings are logged                |

### Async factories

`useFactory` may return a promise. `create()` awaits it before any dependent is
constructed.

```ts
provide(DbConnection, {
  useFactory: async (config: AppConfigService) =>
    DbConnection.open(config.get('databaseUrl')),
  inject: [AppConfigService],
});
```

A rejected factory rejects `AppFactory.create()`. Nothing partially built is
returned, and `onInit` never runs.

`inject` lists `AppConfigService`, the subclass, rather than `ConfigService`. A
factory parameter annotated `ConfigService<AppConfig>` against `inject: [ConfigService]`
is rejected: parameters are contravariant and the token carries no type argument.
[Configuration](./12-configuration.md) covers the `as` option that declares the
subclass.

## `OnInit`

Implement the interface. No registration.

```ts
import type { OnInit } from '@dunx/core';

export class SearchIndex implements OnInit {
  async onInit() {
    await this.warmCache();
  }
}
```

Runs after every provider is constructed, so a dependency is fully built by the
time yours starts. A throwing `onInit` rejects `create()`.

## `OnShutdown`

```ts
import type { OnShutdown } from '@dunx/core';

export class QueueConnection implements OnShutdown {
  async onShutdown() {
    await this.client.close();
  }
}
```

`app.shutdown()` runs every `onShutdown` in **reverse construction order**, so a
service tears down before the connection it was built on. It is idempotent:
concurrent callers await the same drain, and `app.closed` resolves once it
finishes.

| Nest                        | dunx               |
| --------------------------- | ------------------ |
| `OnModuleInit`              | `OnInit`           |
| `OnModuleDestroy`           | `OnShutdown`       |
| `onApplicationBootstrap`    | `OnInit`           |
| `beforeApplicationShutdown` | `OnBeforeShutdown` |

## `OnBeforeShutdown`

Shutdown has two phases, and this is the first one. It runs **while the app is still
serving**.

```ts
import type { OnBeforeShutdown } from '@dunx/core';

export class Readiness implements OnBeforeShutdown {
  async onBeforeShutdown() {
    this.accepting = false;
    await Bun.sleep(15_000);
  }
}
```

`onShutdown` is too late for anything that has to be observable from outside.
`@dunx/http` stops the server before tearing providers down, so a hook that flips a
readiness probe there answers on a closed port: a load balancer is still routing when
the socket goes away.

So `app.drain()` runs every `onBeforeShutdown` first, then the port closes, then
`onShutdown` tears down. `shutdown()` calls the drain itself, which is what makes a
process with no server drain at all.

Every `onBeforeShutdown` runs **concurrently**, unlike `onShutdown`. These are
independent waits and the phase should cost the slowest rather than their sum, where
teardown follows dependencies and has to be sequential.

`@dunx/http`'s `HealthModule` is built on this, and its `drainDelayMs` is the window
above. A queue consumer that must stop accepting jobs before its database closes
wants the same phase.

Do not confuse it with `@OnDrain()`, a websocket handler decorator in `@dunx/http`
that fires when socket backpressure clears. Different layer, unrelated.

### Signals

```ts
app.enableShutdownHooks(); // SIGTERM, SIGINT
app.enableShutdownHooks(['SIGTERM']);
app.enableShutdownHooks(['SIGTERM'], { exitAfterMs: false });
```

**This ends the process.** After the drain completes, an `unref()`d timer gives
the runtime 1000 ms to exit on its own, then calls `process.exit`. A process
with nothing pending exits in about 1 ms and the timer never fires; it fires
only when a handle outside the container is still holding the loop open, and it
logs a warning naming that case before exiting.

Pass `exitAfterMs: false` when the app does not own its process, and in any test
that fires a signal at its own runner. A programmatic `app.shutdown()` never
exits the process at any setting.

## Circular dependencies

There is no `forwardRef`. `@dunx/transform` records constructor dependencies as
a **thunk** evaluated at resolution time, so a class declared later in the file,
or reached across a circular import, resolves normally.

A genuine cycle throws `CircularDependencyError` at boot, carrying the full path:

```text
CircularDependencyError: Circular dependency: UsersService -> AuditService -> UsersService
```

`error.cycle` is the same path as a `string[]`.

## Error propagation

| Failure                                     | Surfaces as                                                      |
| ------------------------------------------- | ---------------------------------------------------------------- |
| Erased constructor parameter type           | boot error naming the parameter                                  |
| Constructor parameters, no transform record | boot error quoting the `bunfig.toml` preload                     |
| Token no module exports                     | boot error naming the module that declares it and the one asking |
| Cycle                                       | `CircularDependencyError` with the path                          |
| Rejected `useFactory`                       | rejects `AppFactory.create()`                                    |
| Throwing `onInit`                           | rejects `AppFactory.create()`                                    |
| Throwing `onShutdown` via signal            | logged, exit code 1, **remaining teardown skipped**              |

Every one of these is a rejected `create()` except the last. An app that boots
has resolved everything it declares.

The last row is the one to design around. The teardown loop is unguarded, so the
first `onShutdown` that throws aborts it.

- Every provider after it in the reverse order keeps its resources.
- `app.closed` never resolves.
- `ShutdownHooks` catches the rejection, logs `[dunx] shutdown failed` and arms exit
  code 1. Its exit timer is what still ends the process.

Put a `try` inside any `onShutdown` whose failure should not strand the ones behind
it.

## Overrides in tests

`createTestApp` replaces a binding **in place**, in every scope that holds one:

```ts
const app = await createTestApp({
  modules: [OrdersModule],
  overrides: [provide(Clock, { useValue: new FixedClock('2026-01-01') })],
});
```

The discarded provider is never constructed, so an async `useFactory` that would
have opened the real database does not run.

An override naming a non-class token nothing binds throws. A silent no-op there
produces a test asserting against the provider it believed it had swapped. A class
token nobody bound is accepted instead, and bound lazily, because a class self-binds
on demand anyway.

Full harness, including `createTestServer` and `RecordingLogger`:
[Testing](./11-testing.md).

## Reaching the container

```ts
app.get(UsersService); // root scope view, then any single declarer
app.get(UsersService, OrdersModule); // prefers OrdersModule's view
```

`app.get` is more permissive than constructor injection, being a wiring and
debugging call. With a module argument it prefers that module's view, then falls back
to the root scope's, then to the single module that declares the token, and finally
self-binds a class into the module named. Two scopes binding the token differently is
an error rather than a guess, and a module that is not in the graph at all throws.

`AppRef` is the injectable form, and is dunx's `ModuleRef`.
