# Migrating from NestJS

A gap analysis between what a production NestJS application uses and what dunx
provides, written from the migrating application's point of view.

Status legend: **undesigned** = no decision recorded anywhere · **out of scope** =
refused, with the reasoning below.

## Read this part first: five things that fail at boot

Everything else on this page is a mapping you can look up when you reach it. These
five are what a migrating app hits in the first hour, and each one stops the process
rather than degrading.

**1. The `bunfig.toml` preload is not optional.**

```toml
preload = ["@dunx/transform/preload"]

[test]
preload = ["@dunx/transform/preload"]
```

Constructor injection needs no decorator because a load-time plugin records each
class's parameter types instead. Without the plugin a class with constructor
parameters has no record, and the container compares that against
`Function.prototype.length` and fails at boot naming the class.

- **Both entries are needed.** Bun's test runner reads its own `preload`, so missing
  the second gives you a working app and a failing suite.
- **It is a runtime dependency.** A `--production` install, or a `.dockerignore` that
  drops `bunfig.toml`, breaks the deploy rather than the build.

Deploying a **built** tree changes the answer. The plugin's filter is `/\.tsx?$/`, so
it never sees emitted JavaScript and no preload setting makes it. Record the
dependencies at build time instead, with `Bun.build({ plugins: [depsPlugin] })`. The
boot error tells you which of the two situations you are in.

**2. A constructor parameter must name something that exists at runtime.**

An interface, a primitive, a union, a class type parameter or a value imported with
`import type` all erase, so there is no token to resolve.
`emitDecoratorMetadata` degrades those to `Object` and hands you `undefined` three
frames from the mistake. dunx fails at boot naming the parameter and its position.

Replace the type with an abstract class, or bind it with `token()` and declare the
parameter as that token. Every `*Options` in the framework is a class for this reason.
The error tells the `import type` case apart from the others, because that one has a
one-line fix.

**3. A type alias is not a class, even when it aliases one.**

Item 2's root cause in a disguise, and it gets its own number because the alias
_resolves_ to a class, so it does not read like an erasure:

```ts
type Db = SyncDatabase<AppSchema>;

class UsersRepository {
  constructor(private readonly db: Db) {} // boot error
}
```

`type` declares no runtime value, so the transform has nothing to record and the
parameter is reported `unresolved`. Stated positively: **a constructor annotates the
class; everything else annotates the alias.**

One migration hit this three times in three repositories before it stuck.

**4. A module is decorated or configured, never both.**

A scope is keyed on the module **reference**, and `forRoot()` returns a fresh object
on every call. So `@Module` on a class that also has a `static forRoot()` registers
its contents twice, and two importers each calling `forRoot()` build two scopes with
two instances of everything in them. Take one:

| The module          | Spelling                                                |
| ------------------- | ------------------------------------------------------- |
| Has nothing to vary | `@Module({ ... })` on the class                         |
| Takes options       | `static forRoot(opts): DynamicModule`, and no decorator |

If two feature modules need the same binding, give it its own module with
`global: true` rather than calling `forRoot()` twice.

**5. Relative imports end in `.js` under `nodenext`, and nowhere else.**

Not `.ts`, not extensionless. Whether this is the largest diff of the migration or
no diff at all depends on a setting the app already has:

| Your `moduleResolution` | What changes                                               |
| ----------------------- | ---------------------------------------------------------- |
| `nodenext`              | Every relative import gains `.js`. Large mechanical diff.  |
| `bundler`               | Nothing. Subpath exports and `paths` aliases both resolve. |

The scaffold sets `nodenext`, where the extension is a compile error rather than a
consumer's problem. An app already on `bundler` keeps its extensionless imports and
its `paths` aliases: one migration of a production application touched no import
specifier at all.

## One handler per job name

Not a boot failure you will hit in the first hour, but a semantic difference worth
knowing before the queue work starts.

A Nest dispatcher that fans one routing key out to every subscriber has no dunx
equivalent: two handlers claiming the same `(queue, name)` is a boot error.

An app doing fan-out decides, per channel, what a retry means there. One migration
landed on the in-app notification firing on the first attempt only, since a toast
arriving after a backoff is stale, and the Slack notification awaited and
rethrowing, since it benefits from retries.

`QueueModule.forRoot({ consume: 'if-any' })` exists for the other half of this: it
stands down instead of failing when the graph has no `@JobHandler` yet, so the queue
wiring can land several commits before the first handler. `consume: true` keeps
refusing.

## Core DI

| Nest surface                        | dunx                                                              | Status     |
| ----------------------------------- | ----------------------------------------------------------------- | ---------- |
| Constructor injection               | native, resolved from the parameter type                          | done       |
| `@Injectable()`                     | delete it, every class is injectable                              | done       |
| `@Module({ imports, providers })`   | [same shape, a scope per module](./guide/04-modules.md)           | done       |
| `@Global()`                         | `global: true` on the same options object                         | done       |
| `exports`                           | [`exports`, tokens or module references](./guide/04-modules.md)   | done       |
| `{ provide, useClass/useValue }`    | [`provide()`](./guide/03-providers.md)                            | done       |
| `useFactory` + `inject`             | [`provide(T, { useFactory, inject })`](./guide/07-lifecycle.md)   | done       |
| `OnModuleInit` / `OnModuleDestroy`  | [`OnInit` / `OnShutdown`](./guide/07-lifecycle.md)                | done       |
| `enableShutdownHooks`               | [same name, and it ends the process](./guide/07-lifecycle.md)     | done       |
| `app.get(Token)` / `ModuleRef`      | [`app.get(Token)` / `AppRef`](./guide/07-lifecycle.md)            | done       |
| `Module.forRoot(opts)`              | `DynamicModule` from a static factory                             | done       |
| `@Optional()`                       | -                                                                 | undesigned |
| `forwardRef()`                      | [not needed, the deps record is a thunk](./guide/07-lifecycle.md) | n/a        |
| `Scope.REQUEST` / `Scope.TRANSIENT` | [one lifetime, and why](./guide/07-lifecycle.md)                  | n/a        |

## HTTP

| Nest surface                            | dunx                                                                    | Status       |
| --------------------------------------- | ----------------------------------------------------------------------- | ------------ |
| `@Controller` / `@Get` / `@Post` / …    | [same](./guide/05-controllers.md)                                       | done         |
| Route params (`/:id`)                   | native `Bun.serve({ routes })`                                          | done         |
| Exception filters                       | [`ErrorFilter` class, or a mapper](./guide/08-middleware-and-guards.md) | done         |
| Global middleware                       | `HttpOptions.middleware`                                                | done         |
| Module middleware (`forRoutes`)         | [`@Module({ middleware })`](./guide/08-middleware-and-guards.md)        | done         |
| Per-controller / per-route middleware   | `@UseGuards`                                                            | done         |
| `@SetMetadata` + `Reflector`            | `meta` / `metaKey` + `ctx.get`                                          | done         |
| `@UseGuards` / `@Roles` / `@Public`     | same names                                                              | done         |
| `@Body` / `@Query` / `@Param`           | [schemas on the route decorator](./guide/06-validation.md)              | done         |
| `createParamDecorator` (`@CurrentUser`) | -                                                                       | undesigned   |
| `setGlobalPrefix`                       | `app.setGlobalPrefix()`                                                 | done         |
| `enableCors`                            | `app.enableCors()`                                                      | done         |
| `app.getUrl()`                          | `listen()` returns the URL                                              | done         |
| `app.use(expressMiddleware)`            | -                                                                       | out of scope |
| `@HttpCode` / `@Header` / `@Redirect`   | `status` in the options, `Response`                                     | n/a          |

## Ecosystem

| Nest package                           | dunx                                                                                                  | Status       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------ |
| `nestjs-zod` / `ValidationPipe`        | [Standard Schema on route decorators](./guide/06-validation.md)                                       | done         |
| `@nestjs/testing` (`overrideProvider`) | [`createTestApp({ modules, overrides })`](./guide/11-testing.md)                                      | done         |
| `@nestjs/swagger`                      | [`@dunx/openapi`](./guide/10-openapi.md)                                                              | done         |
| `@nestjs/bullmq`                       | [`@dunx/infra/queue`](./guide/15-queues.md)                                                           | done         |
| `@thallesp/nestjs-better-auth`         | [`@dunx/auth`](./guide/17-authentication.md)                                                          | done         |
| `@nestjs/websockets` + socket.io       | [gateways on `Bun.serve`](./guide/09-websockets.md)                                                   | done         |
| `@nestjs/serve-static`                 | `StaticFiles` in `@dunx/http`                                                                         | done         |
| `@bull-board/*`                        | bull-board mounted by `@dunx/dashboard`                                                               | done         |
| `@nestjs/cache-manager`                | `RedisConnection.set` with a TTL; no store or `@Cacheable`                                            | partial      |
| `@nestjs/schedule` (`@Cron`)           | [`@dunx/infra/schedule`](./guide/16-scheduling.md)                                                    | done         |
| `@nestjs/throttler`                    | `ThrottleModule`, `ThrottleGuard`, `@Throttle`, `@SkipThrottle`, `RedisThrottleStore` in `@dunx/http` | done         |
| `@nestjs/terminus`                     | [`HealthModule` in `@dunx/http`](./guide/20-health-checks.md)                                         | done         |
| `@nestjs/platform-express` (`app.use`) | -                                                                                                     | out of scope |

## The reference application

Numbers below were counted against [nestjs-template](https://github.com/petarzarkov/nestjs-template) (monolith:
Drizzle, BullMQ, Redis, Better Auth, socket.io, Swagger + Scalar, an
OpenAPI-driven admin CMS) on 2026-07-28. It is the acceptance test - "dunx is
ready" means that app can move without redesign.

| Surface                                                | Count      |
| ------------------------------------------------------ | ---------- |
| Files with constructor injection                       | 45         |
| `@Injectable()`                                        | 32         |
| `@Module()` / `@Global()`                              | 20 / 9     |
| `static forRoot` / `forRootAsync` definitions          | 4          |
| Files reading `Reflector` / `ExecutionContext`         | 9          |
| `@Roles` / `@Public` / `@UseGuards`                    | 13 / 5 / 1 |
| Custom param decorators (`@CurrentUser`, `@UuidParam`) | 14         |
| Built-in param decorators (`@Body`, `@Query`, `@Res`)  | 9          |
| `@Api*` (Swagger)                                      | ~80        |
| WebSocket decorators                                   | 6          |

## Constructor injection is native

`@dunx/transform` reads constructor parameter types at load time and records them
on the class, so the Nest shape works unchanged:

```ts
// Nest
@Injectable()
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}
}

// dunx - delete one line
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}
}
```

Apps opt in with one line in `bunfig.toml`:

```toml
preload = ["@dunx/transform/preload"]
```

See architecture/dependency-injection.md, "Constructor injection without decorator metadata", for how
it works and what it refuses to guess.

What still changes, per class:

| Nest                                      | dunx                                              |
| ----------------------------------------- | ------------------------------------------------- |
| `@Injectable()`                           | delete it - every class is injectable             |
| `@Inject(TOKEN) private x: T`             | declare the parameter as the token's type         |
| `@Global()`                               | `global: true` on the same options object         |
| `exports: [...]`                          | `exports: [...]`, unchanged                       |
| `{ provide: X, useClass: Y }`             | `provide(X, { useClass: Y })`                     |
| `OnModuleInit`                            | `OnInit` - on a service as well as a module       |
| `OnModuleDestroy`                         | `OnShutdown` - likewise                           |
| `NestFactory.create`                      | `HttpFactory.create`                              |
| `config.get('a.b')`                       | same, up to three segments deep                   |
| `logger.log(...)`                         | `logger.info(...)` - `log` works, deprecated      |
| `@HttpCode(HttpStatus.CREATED)` on a POST | delete it - POST answers 201 already              |
| relative imports                          | `.js` under `nodenext`, unchanged under `bundler` |

Custom parameter decorators have no target API. See
[What is still missing](#what-is-still-missing).

### String tokens

`@Inject('SOME_STRING')` has no equivalent. A dunx token is an object identity
from `token<T>()` rather than a name, so a string token becomes an exported
constant that both sides import. This is the only case where the parameter type
alone is insufficient.

## What comes free

- **`@Global()` disappears as a decorator**, becoming `global: true` on the same
  options object the module already has. Nest needs both spellings because
  `DynamicModule` cannot carry a decorator; dunx needs one.
- **`reflect-metadata` and its import-order fragility disappear.**
- **`@Injectable()` disappears.** Every class is injectable.
- **`@Inject()` disappears** for everything a parameter type can name, which is
  everything except a string token. Nest needs it wherever
  `emitDecoratorMetadata` degrades a type to `Object`; dunx reads the real type
  from source, so there is nothing to work around.
- **`forwardRef()` disappears.** Dependencies are recorded as a thunk evaluated at
  resolution time, so a circular import is not a temporal-dead-zone crash. A
  genuine cycle is a boot error naming the full path.
- **An erased parameter fails at boot**, reported with its own source text
  instead of quietly resolving to the wrong thing.
- **Provider scope disappears.** One lifetime, singleton per module scope:
  [Lifecycle](./guide/07-lifecycle.md).
- **Boot is eager**, so a wiring error is a boot error rather than a
  first-request 500.
- **Guards, interceptors, pipes, and filters collapse into one `Middleware`
  concept** - five extension points become one. See "The request lifecycle" below.

## The request lifecycle

Nest documents nine numbered stages over five base classes. dunx has the same
lifecycle with one interface, because the stages were never separate mechanisms -
they were separate registration points for the same nesting.

| Nest stage                                | dunx                                             |
| ----------------------------------------- | ------------------------------------------------ |
| 2.1 Globally bound middleware             | `HttpOptions.middleware` / `app.use()`           |
| 2.2 Module bound middleware               | `@Module({ middleware })`                        |
| 3.1-3.3 Guards: global, controller, route | the same two, plus `@UseGuards`                  |
| 4.1-4.3 Interceptors, pre-controller      | anything before `await next()`                   |
| 5.1-5.4 Pipes, including parameter pipes  | the route decorator's schemas                    |
| 6-7 Controller, then services             | unchanged                                        |
| 8.1-8.3 Interceptors, post-request        | anything after `await next()`                    |
| 9.1-9.3 Exception filters: route → global | `onError`; or `try` around `next()` at any layer |

Resolved, outermost first: the error filter, request logging, global middleware,
`app.use()` middleware, the declaring module's middleware, controller guards, method
guards, validation, the handler - then back out through all of it.
`@dunx/http`'s lifecycle suite asserts that list in one request.

What a migrating app stops writing:

- **`configure(consumer)` and `forRoutes()`.** A module owns its controllers, so
  `@Module({ middleware })` already names the routes. There is no path-matching
  language and no `MiddlewareConsumer`.
- **Separate `guards`, `interceptors` and `pipes` arrays**, and the three base
  classes behind them. A guard is middleware that throws; an interceptor is
  middleware that wraps `next()`.
- **`@Catch` and per-controller filters.** A middleware with a `try` around
  `next()` is a scoped filter, at whichever scope it was installed. Rethrowing is
  the cascade.
- **`ExecutionContext` and `Reflector`.** `handle(req, ctx, next)` gets `ctx`
  already merged at boot, so reading route metadata is a `Map` lookup rather than a
  per-request reflection call.

The one thing it gains: **ordering is a list you can read**. Within a scope it is
array order, and across scopes it is the table above, with no ancestor inheritance
to collate across files.

## What is still missing

### Custom param decorators

`createParamDecorator` has no successor and will not get one: TC39 decorators have
no parameter decorators, so there is nowhere for it to come from. The reference app
has 14 usages across `@CurrentUser` and `@UuidParam`, and the two halves of that
migrate differently.

`@UuidParam` and its relatives are **validation**, and are answered: the schema moves
onto the route decorator, where it also coerces and documents. See
[Validation](./guide/06-validation.md).

`@CurrentUser` and its relatives read **state a guard put there**, and the shape that
replaced them is an injected service over `AsyncLocalStorage`. `@dunx/auth` ships one:

```ts
export class ProfileController {
  constructor(private readonly auth: AuthContext) {}

  @Get('/me')
  me() {
    return this.users.findById(this.auth.require().id);
  }
}
```

`current()` returns the caller or `undefined`; `require()` returns the caller or
throws a 401. `SessionGuard` is what calls `run()` to establish it, and a job or a
socket handler that resolved a session itself can call `run()` too.

The gain over a parameter decorator is that it reaches **anything the handler calls,
however deep**, rather than only the handler's own signature. The cost is that the
caller is not in the method signature, so it does not appear in the handler's type.
An app wanting its own `@CurrentUser` writes a one-method service over `AuthContext`
and injects that.

### `@Optional()`

No equivalent, and no design. Every constructor parameter is required, and a
parameter whose type is erased is a boot error rather than an `undefined`. An
optional collaborator is expressed today as a provider that binds a no-op
implementation.

## Out of scope

**Express interop.** `app.use(expressMiddleware)` and mounting express-shaped
handlers have no equivalent. Two of the things usually reached for through it do ship:

- `app.set('trust proxy', n)` is the one key `AppSettings` declares. It counts hops
  from the right-hand end of `X-Forwarded-For`.
- bull-board is mounted by `@dunx/dashboard`, not by an express adapter.
  `Bun.serve` is not a middleware stack, and building an express compatibility
  layer would contradict "dunx should stay a DI + structure framework that happens
  to serve HTTP." Applications depending on mounted express apps need those
  replaced, not adapted.

**The socket.io protocol.** Gateways are neither out of scope nor a separate
package: `@Gateway` ships in `@dunx/http` on Bun's native WebSocket support, and
multi-node fan-out ships as a relay.

What is out of scope is **protocol compatibility**. A socket.io client cannot talk to
a dunx gateway, so anything depending on the socket.io wire format, its
acknowledgement semantics or `@socket.io/redis-adapter` needs replacing rather than
adapting. See [WebSockets](./guide/09-websockets.md).

Check both before planning a migration. They gate whether an app can move today.

## The acceptance test

The parity target is a running app with a config module, an async database factory,
CRUD controllers, an auth guard reading `@Roles`, OpenAPI, queues and a health
endpoint. [`examples/full`](https://github.com/petarzarkov/dunx/tree/main/examples/full)
is the version of that which CI keeps alive.

It exercises the question module scoping introduced, which is which
cross-cutting guards were only ever cross-cutting because Nest offered nowhere
else to put them. `SessionGuard` stays app-wide. A throttle on one feature's
routes, or an audit stamp on one feature's writes, becomes a
`@Module({ middleware })` line.
