# Migrating from NestJS

What a production NestJS app uses, and what to write instead in dunx.

In the tables below, **done** means dunx has it, spelled as shown. **partial**
means it ships with a gap, named in the same cell. **n/a** means dunx does not
have the problem, so there is nothing to port. **undesigned** means no decision
has been made yet. **out of scope** means dunx will not add it; the reasons are at
the end.

## Read this part first: five things that fail at boot

These five mistakes are the ones you will hit in the first hour, and each one stops the app at boot. A sixth, import
extensions, fails even earlier, when the code compiles or loads.

**1. The `bunfig.toml` preload is not optional.**

```toml
preload = ["@dunx/transform/preload"]

[test]
preload = ["@dunx/transform/preload"]
```

Constructor injection works without decorators because this plugin reads each
class's parameter types when the file loads. Without it, boot fails and the error
names the class.

- **You need both entries.** Bun's test runner reads its own `preload`, so without
  the second one the app runs and the tests fail.
- **It is needed at runtime.** A `--production` install, or a `.dockerignore` that
  leaves out `bunfig.toml`, breaks the deploy, not the build.

If you deploy **built JavaScript**, the preload does not help: the plugin only
reads `.ts` and `.tsx` files. Add it to your build instead, with
`Bun.build({ plugins: [depsPlugin] })`. The boot error says which of the two
fixes applies.

**2. A constructor parameter must name something that exists at runtime.**

Interfaces, primitives, unions, generic type parameters and anything imported with
`import type` disappear when TypeScript compiles, so there is nothing left to
inject. In Nest, `emitDecoratorMetadata` turns these into `Object` and you get
`undefined` somewhere later. dunx fails at boot and names the parameter and its
position.

Two fixes:

- Change the type to an abstract class. Every `*Options` in dunx is a class for
  this reason.
- Or bind the value with `token()`, and read it with `inject(TOKEN)` in a field
  initializer instead of the constructor. See [Providers](./guide/03-providers.md).

When the cause is `import type`, the error says so: change it to a plain `import`.

**3. A type alias is not a class, even when it aliases one.**

This is the same problem as item 2, but harder to spot, because the alias points
at a real class:

```ts
type Db = SyncDatabase<AppSchema>;

class UsersRepository {
  constructor(private readonly db: Db) {} // boot error
}
```

A `type` does not exist at runtime, so the plugin has nothing to record and boot
reports the parameter as `unresolved`. **Name the class itself in a constructor.
Use the alias everywhere else.**

One migration hit this three times, in three repositories.

**4. A module is decorated or configured, never both.**

dunx tells modules apart by object identity, and `forRoot()` returns a new object
every time you call it. So `@Module` on a class that also has `static forRoot()`
registers everything twice, and two importers that each call `forRoot()` get two
separate copies of every provider. Pick one form:

| The module          | Spelling                                                |
| ------------------- | ------------------------------------------------------- |
| Has nothing to vary | `@Module({ ... })` on the class                         |
| Takes options       | `static forRoot(opts): DynamicModule`, and no decorator |

If two feature modules need the same binding, put it in its own module with
`global: true` and call `forRoot()` once.

**5. A class no module lists belongs to the first scope that asks for it.**

Nest refuses to inject a provider that no module lists. dunx lets you inject any
class, and an unlisted class is registered in the module of whoever asks for it
first. When a second module then asks for it, boot fails, because the first module
does not export it.

List the class in one module's `providers` and `exports`, and import that module
wherever you need it. This matters most for framework services: bind them in the
module that owns them.

### Before boot: relative imports end in `.js` under `nodenext`

This one fails when the code compiles or loads, before boot. Whether it means
changing every import or none depends on your `moduleResolution` setting:

| Your `moduleResolution` | What changes                                               |
| ----------------------- | ---------------------------------------------------------- |
| `nodenext`              | Every relative import gains `.js`. Large mechanical diff.  |
| `bundler`               | Nothing. Subpath exports and `paths` aliases both resolve. |

New projects from the scaffold use `nodenext`, so a missing extension is a
compile error you fix once. An app already on `bundler` keeps its extensionless
imports and `paths` aliases. One production migration changed no imports at all.

## One handler per job name

This one does not stop boot, but it changes how queue code is written.

In Nest, one job can be delivered to several subscribers. In dunx, each queue and
job name has exactly one handler, and two handlers for the same pair fail at boot.

If you relied on fan-out, decide for each side effect what a retry should do. One
migration sent the in-app notification on the first attempt only, because a toast
that arrives after a retry delay is stale. It let the Slack notification throw and
retry, because that one is still useful late.

`QueueModule.forRoot({ consume: 'if-any' })` starts without complaint when there is
no `@JobHandler` yet, so you can add the queue wiring before the first handler.
`consume: true` still fails at boot when there is none.

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
| `@Body` / `@Query` / `@Param`           | [one input object, typed by the schema](#handler-parameters)            | done         |
| `createParamDecorator` (`@CurrentUser`) | [no successor, two answers](#custom-param-decorators)                   | n/a          |
| `setGlobalPrefix`                       | `app.setGlobalPrefix()`                                                 | done         |
| `enableCors`                            | `app.enableCors()`                                                      | done         |
| `app.getUrl()`                          | `listen()` returns the URL                                              | done         |
| `app.use(expressMiddleware)`            | -                                                                       | out of scope |
| `@HttpCode` / `@Header` / `@Redirect`   | `status` in the options, `Response`                                     | n/a          |

### Handler parameters

Nest gives each part of the request its own parameter decorator. dunx passes one
object, typed by the schema on the route decorator:

```ts
// Nest
@Post()
create(@Body() dto: CreateUserDto): Promise<User> {
  return this.users.create(dto.name);
}

// dunx
@Post('/', createUser)
create({ body }: Input<typeof createUser>): Promise<User> {
  return this.users.create(body.name);
}
```

| Nest                      | dunx                                    |
| ------------------------- | --------------------------------------- |
| `@Body() dto: CreateUser` | `{ body }: Input<typeof createUser>`    |
| `@Query() q: ListQuery`   | `{ query }: Input<typeof listUsers>`    |
| `@Param('id') id: string` | `{ params }: Input<typeof oneUser>`     |
| `@Req() req: Request`     | `{ req }: Input<RouteSchemas>`          |
| `@Res() res: Response`    | return a `Response`                     |
| `@Headers('x-trace') v`   | `req.headers.get('x-trace')`            |
| `@Ip() ip: string`        | `ClientAddress`, then `address.of(req)` |

Destructure the parts you need, or take the whole object; the types are the same.
One schema replaces Nest's DTO class, `ValidationPipe` and `@ApiProperty`: it
validates the request, types the handler and describes the route in the OpenAPI
document.

There is no `@Res()`. To set the status, headers or body yourself, return a
`Response`. The route still runs its middleware, guards and error handling.

Standard decorators cannot be put on parameters. See
[Custom param decorators](#custom-param-decorators) for what replaces
`createParamDecorator`.

## Ecosystem

| Nest package                           | dunx                                                                                                  | Status       |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------ |
| `nestjs-zod` / `ValidationPipe`        | [Standard Schema on route decorators](./guide/06-validation.md)                                       | done         |
| `@nestjs/testing` (`overrideProvider`) | [`createTestApp({ modules, overrides })`](./guide/11-testing.md)                                      | done         |
| `@nestjs/swagger`                      | [`@dunx/openapi`](./guide/10-openapi.md)                                                              | done         |
| `@nestjs/bullmq`                       | [`@dunx/infra/queue`](./guide/19-queues.md)                                                           | done         |
| `@thallesp/nestjs-better-auth`         | [`@dunx/auth`](./guide/17-authentication.md)                                                          | done         |
| `@nestjs/websockets` + socket.io       | [gateways on `Bun.serve`](./guide/09-websockets.md)                                                   | done         |
| `@nestjs/serve-static`                 | `StaticFiles` in `@dunx/http`                                                                         | done         |
| `@bull-board/*`                        | bull-board mounted by `@dunx/dashboard`                                                               | done         |
| `@nestjs/cache-manager`                | [`@dunx/infra/cache`](./guide/15-caching.md); no `@Cacheable`                                         | partial      |
| `@nestjs/schedule` (`@Cron`)           | [`@dunx/infra/schedule`](./guide/16-scheduling.md)                                                    | done         |
| `@nestjs/throttler`                    | `ThrottleModule`, `ThrottleGuard`, `@Throttle`, `@SkipThrottle`, `RedisThrottleStore` in `@dunx/http` | done         |
| `@nestjs/terminus`                     | [`HealthModule` in `@dunx/http`](./guide/22-health-checks.md)                                         | done         |
| `@nestjs/platform-express` (`app.use`) | -                                                                                                     | out of scope |

## The reference application

These counts come from [nestjs-template](https://github.com/petarzarkov/nestjs-template),
a monolith using Drizzle, BullMQ, Redis, Better Auth, socket.io, Swagger, Scalar and
an OpenAPI-driven admin CMS, counted on 2026-07-28. dunx is ready when that app can
move over without being redesigned.

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

`@dunx/transform` reads constructor parameter types when the file loads, so a
Nest service works as it is, minus one line:

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

[Constructor injection without decorator metadata](./architecture/dependency-injection.md#constructor-injection-without-decorator-metadata)
explains how it works and which cases it refuses to guess.

What else changes in each class, beyond the [Core DI](#core-di) table:

| Nest                                      | dunx                                              |
| ----------------------------------------- | ------------------------------------------------- |
| `@Inject(TOKEN) private x: T`             | `readonly x = inject(TOKEN)`, a field initializer |
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

There is no `@Inject('SOME_STRING')`. A dunx token is an object made by
`token<T>()`, not a string. Export it as a constant, import it on both sides, and
read it with `inject()`.

## What comes free

- **No `reflect-metadata`**, and no import-order bugs from it.
- **No `@Inject()`**, except to read a `token()`. dunx reads the real parameter
  type from source, so there is no `Object` to work around.
- **No `forwardRef()`.** Dependencies are looked up when they are needed, so a
  circular import does not crash. A real dependency cycle fails at boot and shows
  the whole cycle.
- **A parameter whose type is gone fails at boot**, quoting its source text, instead
  of resolving to the wrong thing.
- **No provider scopes.** There is one lifetime: one instance per module. See
  [Lifecycle](./guide/07-lifecycle.md).
- **Everything is created at boot**, so a wiring mistake fails at startup, not as
  a 500 on the first request.
- **Guards, interceptors, pipes and filters are all `Middleware`**: one extension
  point instead of five. See "The request lifecycle" below.

## The request lifecycle

Nest documents nine numbered stages and five base classes. dunx runs the same
stages with one interface: each Nest stage is a place to register a wrapper around
the handler, and dunx has one kind of wrapper.

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

The order, from the outside in, is: the error filter, request logging, global
middleware, `app.use()` middleware, the module's middleware, controller guards,
method guards, validation, then the handler. The response goes back out through the
same layers. `@dunx/http`'s lifecycle tests check this order in a single request.

What you no longer write:

- **`configure(consumer)` and `forRoutes()`.** A module owns its controllers, so
  `@Module({ middleware })` already applies to the right routes. There is no
  `MiddlewareConsumer` and no path patterns.
- **Separate `guards`, `interceptors` and `pipes` arrays**, and their base
  classes. A guard is middleware that throws. An interceptor is middleware that
  wraps `next()`.
- **`@Catch` and per-controller filters.** Put a `try` around `next()` in a
  middleware, and it catches errors for wherever that middleware is installed.
  Rethrow to pass an error outward.
- **`ExecutionContext` and `Reflector`.** `handle(req, ctx, next)` receives `ctx`
  with the route's metadata already merged at boot. Reading it is a `Map` lookup.

**Middleware runs in an order you can see.** Inside one scope it runs in array
order. Across scopes it follows the table above. A module does not inherit
middleware from the modules that import it.

## What is still missing

### Custom param decorators

`createParamDecorator` has no replacement and will not get one, because standard
decorators cannot go on parameters. The reference app uses custom parameter
decorators 14 times, in two kinds that migrate differently.

Decorators like `@UuidParam` **validate input**. Move the schema onto the route
decorator, where it also converts the value and documents it. See
[Validation](./guide/06-validation.md).

Decorators like `@CurrentUser` **read something a guard stored**. Inject a
service that reads it from the current request instead. `@dunx/auth` ships one:

```ts
export class ProfileController {
  constructor(private readonly auth: AuthContext) {}

  @Get('/me')
  me() {
    return this.users.findById(this.auth.require().id);
  }
}
```

`current()` returns the signed-in user or `undefined`. `require()` returns the
user or throws a 401. `SessionGuard` sets it for each request by calling `run()`,
and a job or socket handler that loads a session itself can call `run()` too.

Unlike a parameter decorator, this works in **anything the handler calls, however
deep**. The trade-off is that the user no longer appears in the handler's
signature. For your own `@CurrentUser`, write a small service over `AuthContext`
and inject it.

### `@Optional()`

There is no equivalent yet. Every constructor parameter is required, and one whose
type is gone at runtime fails at boot. For an optional dependency today, bind a
provider that does nothing.

## Out of scope

**Express middleware.** You cannot `app.use(expressMiddleware)` or mount an
Express app. Two things people usually use Express for are built in:

- `app.set('trust proxy', n)` is supported. It counts proxy hops from the right
  of `X-Forwarded-For`.
- `@dunx/dashboard` mounts bull-board for you.

`Bun.serve` is not a middleware stack, and dunx will not add an Express
compatibility layer. If your app mounts Express apps, plan to replace them.

**The socket.io protocol.** WebSocket gateways are supported: `@Gateway` is in
`@dunx/http`, on Bun's native WebSockets, with a relay for running several nodes.

What is not supported is the socket.io protocol itself. A socket.io client cannot
talk to a dunx gateway, so code that depends on socket.io's message format, its
acknowledgements or `@socket.io/redis-adapter` has to be replaced. See
[WebSockets](./guide/09-websockets.md).

Check both of these before you plan a migration. They decide whether your app can
move today.

## The acceptance test

The target is a running app with a config module, an async database factory, CRUD
controllers, an auth guard reading `@Roles`, OpenAPI, queues and a health endpoint.
[`examples/full`](https://github.com/petarzarkov/dunx/tree/main/examples/full) is
that app, and CI runs it on every change.

In Nest, some guards are global only because there was nowhere else to put them.
In dunx, keep `SessionGuard` global, and move a guard that serves one feature,
such as a throttle or an audit stamp on its writes, into that feature's
`@Module({ middleware })`.
