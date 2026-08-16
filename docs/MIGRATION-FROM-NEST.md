# Migrating from NestJS

A gap analysis between what a production NestJS application uses and what dunx
provides, written from the migrating application's point of view.

Status legend: **planned** = designed in ARCHITECTURE.md, unbuilt ·
**undesigned** = no decision recorded anywhere.

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

| Nest package                           | dunx                                                             | Status       |
| -------------------------------------- | ---------------------------------------------------------------- | ------------ |
| `nestjs-zod` / `ValidationPipe`        | [Standard Schema on route decorators](./guide/06-validation.md)  | done         |
| `@nestjs/testing` (`overrideProvider`) | [`createTestApp({ modules, overrides })`](./guide/11-testing.md) | done         |
| `@nestjs/swagger`                      | [`@dunx/openapi`](./guide/10-openapi.md)                         | done         |
| `@nestjs/bullmq`                       | [`@dunx/infra/queue`](./guide/15-queues.md)                      | done         |
| `@thallesp/nestjs-better-auth`         | [`@dunx/auth`](./guide/16-authentication.md)                     | done         |
| `@nestjs/websockets` + socket.io       | [gateways on `Bun.serve`](./guide/09-websockets.md)              | done         |
| `@nestjs/serve-static`                 | `StaticFiles` in `@dunx/http`                                    | done         |
| `@bull-board/*`                        | bull-board mounted by `@dunx/dashboard`                          | done         |
| `@nestjs/cache-manager`                | `@dunx/infra/redis`                                              | partial      |
| `@nestjs/schedule` (`@Cron`)           | bullmq repeatable jobs                                           | undesigned   |
| `@nestjs/throttler`                    | middleware                                                       | undesigned   |
| `@nestjs/terminus`                     | -                                                                | undesigned   |
| `@nestjs/platform-express` (`app.use`) | -                                                                | out of scope |

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

| Nest                          | dunx                                      |
| ----------------------------- | ----------------------------------------- |
| `@Injectable()`               | delete it - every class is injectable     |
| `@Inject(TOKEN) private x: T` | declare the parameter as the token's type |
| `@Global()`                   | `global: true` on the same options object |
| `exports: [...]`              | `exports: [...]`, unchanged               |
| `{ provide: X, useClass: Y }` | `provide(X, { useClass: Y })`             |
| `OnModuleInit`                | `OnInit`                                  |
| `OnModuleDestroy`             | `OnShutdown`                              |
| `NestFactory.create`          | `HttpFactory.create`                      |
| relative imports              | add the `.js` extension                   |

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
`packages/http/src/server/lifecycle.test.ts` asserts that list in one request.

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

`createParamDecorator` is a Nest extensibility point with **no successor
designed**. The reference app has 14 usages across `@CurrentUser` and
`@UuidParam`.

`@Body`/`@Query`/`@Param` are already answered - schemas move onto the route
decorator (architecture/dependency-injection.md, "Params without parameter decorators"). Custom ones
are not, because they read state a guard put there.

The natural shape is that middleware writes onto a typed per-request context the
handler receives:

```ts
@Get('/me', { auth: true })
getMe(req: BunRequest, ctx: Ctx<{ user: User }>) {
  return this.#users.findById(ctx.user.id);
}
```

This still needs a decision, and it shares a signature with validated input, so it
belongs in ARCHITECTURE.md before any of it is written. Today the workaround is
what a guard already has: put the value on `req` and read it in the handler.

### `@Optional()`

No equivalent, and no design. Every constructor parameter is required, and a
parameter whose type is erased is a boot error rather than an `undefined`. An
optional collaborator is expressed today as a provider that binds a no-op
implementation.

## Out of scope

**Express interop.** `app.use(expressMiddleware)`, `app.set('trust proxy')`, and
mounting express-shaped handlers (Bull Board, ServeStatic) have no equivalent.
`Bun.serve` is not a middleware stack, and building an express compatibility
layer would contradict "dunx should stay a DI + structure framework that happens
to serve HTTP." Applications depending on mounted express apps need those
replaced, not adapted.

**socket.io.** Bun has native WebSocket support with a different shape. A
`@dunx/ws` is plausible; a socket.io-protocol-compatible one is not, and the
`@socket.io/redis-adapter` multi-node story would have to be rebuilt.

Check both before planning a migration. They gate whether an app can move today.

## The acceptance test

`dunx-template` is a running parity app: config module, async database factory,
CRUD controllers, an auth guard reading `@Roles`, OpenAPI, queues and a health
endpoint.

It exercises the question module scoping introduced, which is which
cross-cutting guards were only ever cross-cutting because Nest offered nowhere
else to put them. `SessionGuard` stays app-wide. A throttle on one feature's
routes, or an audit stamp on one feature's writes, becomes a
`@Module({ middleware })` line.
