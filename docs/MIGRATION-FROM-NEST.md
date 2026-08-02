# Migrating from NestJS

A gap analysis between what a production NestJS application actually uses and
what dunx provides. Read [ARCHITECTURE.md](./ARCHITECTURE.md) first - this
document assumes its decisions and does not relitigate them.

This is a **living gap table**. It is also the roadmap's reality check: the
phases in ARCHITECTURE.md were written from the framework's point of view, and
this document is written from a migrating application's point of view. Where the
two disagree, this one names the cost.

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

An earlier revision of this document opened with constructor injection as "the
one unavoidable rewrite" and proposed a codemod for it. That is no longer true,
and the codemod no longer exists.

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

See ARCHITECTURE.md, "Constructor injection without decorator metadata", for how
it works and what it refuses to guess.

What still changes, per class:

| Nest                          | dunx                                        |
| ----------------------------- | ------------------------------------------- |
| `@Injectable()`               | delete it - every class is injectable       |
| `@Inject(TOKEN) private x: T` | declare the parameter as the token's type   |
| `@Global()`                   | delete it - the container is flat           |
| `exports: [...]`              | delete it - there is no visibility boundary |
| `{ provide: X, useClass: Y }` | `provide(X, { useClass: Y })`               |
| `OnModuleInit`                | `OnInit`                                    |
| `OnModuleDestroy`             | `OnShutdown`                                |
| `NestFactory.create`          | `HttpFactory.create`                        |
| relative imports              | add the `.js` extension                     |

Two things genuinely have no target API yet: custom parameter decorators, and
guards that read route metadata. Both are below.

### One behaviour to know about

`@Inject('SOME_STRING')` has no equivalent. A dunx token is an object identity
from `token<T>()`, not a name, so a string token has to become an exported
constant that both sides import. This is the only case where the parameter type
alone is not enough.

## What comes free

Worth leading with in any migration guide, because it is a real reduction in
concept count:

- **`@Global()` disappears.** The container is flat, so all 9 global modules
  become ordinary modules. There is no `exports` list to maintain either.
- **`reflect-metadata` and its import-order fragility disappear.**
- **`@Injectable()` disappears.** Every class is injectable.
- **`@Inject()` disappears** for everything a parameter type can name, which is
  everything except a string token. Nest needs it wherever
  `emitDecoratorMetadata` degrades a type to `Object`; dunx reads the real type
  from source, so there is nothing to work around.
- **`forwardRef()` disappears.** Dependencies are recorded as a thunk evaluated at
  resolution time, so a circular import is not a temporal-dead-zone crash. A
  genuine cycle is a boot error naming the full path.
- **An erased parameter is an error, not an `undefined`.** An interface or
  primitive parameter is reported at boot with its own source text, instead of
  quietly resolving to the wrong thing.
- **Request-scoped providers disappear**, along with the reason to think about
  provider scope at all.
- **Boot is eager**, so a wiring error is a boot error rather than a
  first-request 500.
- **Guards, interceptors, pipes, and filters collapse into one `Middleware`
  concept** - five extension points become one.

## Gap table

Status legend: **blocked** = unimplementable today · **planned** = designed in
ARCHITECTURE.md, unbuilt · **undesigned** = no decision recorded anywhere.

### Core DI

| Nest surface                       | dunx                                 | Status      |
| ---------------------------------- | ------------------------------------ | ----------- |
| Constructor injection              | native, resolved from parameter type | done        |
| `@Injectable()`                    | not needed                           | done        |
| `@Module({ imports, providers })`  | same shape, flat semantics           | done        |
| `@Global()`                        | not needed                           | done        |
| `exports`                          | not needed                           | done        |
| `{ provide, useClass/useValue }`   | `provide()`                          | done        |
| `useFactory` + `inject`            | `provide(T, { useFactory, inject })` | done        |
| `OnModuleInit` / `OnModuleDestroy` | `OnInit` / `OnShutdown`              | done        |
| `app.get(Token)`                   | `app.get(Token)`                     | done        |
| `Module.forRoot(opts)`             | -                                    | **blocked** |
| `@Optional()`                      | -                                    | undesigned  |
| `forwardRef()`                     | not needed - cycles are a boot error | n/a         |
| Request scope                      | rejected by design                   | n/a         |

### HTTP

| Nest surface                            | dunx                           | Status       |
| --------------------------------------- | ------------------------------ | ------------ |
| `@Controller` / `@Get` / `@Post` / …    | same                           | done         |
| Route params (`/:id`)                   | native `Bun.serve({ routes })` | done         |
| Exception filters                       | one `ErrorMapper`              | done         |
| Global middleware                       | `HttpOptions.middleware`       | done         |
| Per-route / per-controller middleware   | -                              | **blocked**  |
| `@SetMetadata` + `Reflector`            | -                              | **blocked**  |
| `@UseGuards` / `@Roles` / `@Public`     | -                              | **blocked**  |
| `@Body` / `@Query` / `@Param`           | schemas on the route decorator | planned (P3) |
| `createParamDecorator` (`@CurrentUser`) | -                              | undesigned   |
| `setGlobalPrefix`                       | -                              | undesigned   |
| `enableCors`                            | -                              | undesigned   |
| `app.getUrl()`                          | `listen()` returns the URL     | done         |
| `app.use(expressMiddleware)`            | -                              | out of scope |
| `@HttpCode` / `@Header` / `@Redirect`   | return a `Response`            | n/a          |

### Ecosystem

| Nest package                           | dunx                                    | Status       |
| -------------------------------------- | --------------------------------------- | ------------ |
| `nestjs-zod` / `ValidationPipe`        | Standard Schema on route decorators     | planned (P3) |
| `@nestjs/testing` (`overrideProvider`) | `createTestApp({ modules, overrides })` | done         |
| `@nestjs/swagger`                      | `@dunx/openapi`                         | planned (P5) |
| `@nestjs/schedule` (`@Cron`)           | -                                       | undesigned   |
| `@nestjs/throttler`                    | middleware                              | undesigned   |
| `@nestjs/cache-manager`                | middleware                              | undesigned   |
| `@nestjs/terminus`                     | -                                       | undesigned   |
| `@nestjs/bullmq` + `@bull-board/*`     | -                                       | undesigned   |
| `@nestjs/websockets` + socket.io       | -                                       | undesigned   |
| `@nestjs/serve-static`                 | -                                       | undesigned   |
| `@nestjs/platform-express` (`app.use`) | -                                       | out of scope |
| `@thallesp/nestjs-better-auth`         | -                                       | undesigned   |

## The blocked items, in dependency order

### 1. Route metadata and scoped middleware

**Do this before `@dunx/http` is published.** Every other blocked item is
additive; this one changes the `Middleware` signature, and changing it after
publish is breaking.

9 files in the reference app do `reflector.get(ROLES_KEY, ctx.getHandler())`.
That is unimplementable in dunx today because:

- `HttpOptions.middleware` in
  [factory.ts](../packages/http/src/server/factory.ts) is global-only.
- `Middleware.handle(req, next)` in
  [middleware.ts](../packages/http/src/server/middleware.ts) receives only
  `BunRequest`. It cannot know which controller or handler matched.
- There is no `@SetMetadata` equivalent and no way to read a marker back.

The mechanism already exists - `Symbol.for('dunx.route')` on the method function
in [marker.ts](../packages/http/src/route/marker.ts). Generalise it:

```ts
export const meta =
  <T>(key: MetaKey<T>, value: T) =>
  <M extends Fn>(method: M): M => { … };

export const Roles = (...roles: Role[]) => meta(ROLES, roles);
export const Public = () => meta(PUBLIC, true);

interface RouteContext {
  readonly controller: string;
  readonly handler: string;
  get<T>(key: MetaKey<T>): T | undefined;
}

interface Middleware {
  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response>;
}
```

Discovery already walks the prototype chain per instance, so it can collect
markers into a frozen `RouteContext` at boot. `compose()` in middleware.ts folds
one closure per route, so `ctx` is a closed-over constant - **no reflection per
request**, which is the whole reason Nest's `Reflector` is a per-request cost and
this is not.

The same change gives `@UseGuards` a landing spot: middleware declared on the
route decorator or on `@Module({ controllers })`, composed into that route's
chain only.

### 2. Dynamic modules

`ModuleClass` in [module.ts](../packages/core/src/di/module.ts) is
`abstract new (...args: never[]) => object`, so `imports: [ConfigModule.forRoot({
validate })]` does not typecheck. The reference app defines 4 of its own and
consumes a dozen more from third-party packages - it is _the_ idiom for a
configurable module, and no Nest app of any size avoids it.

```ts
type ModuleRef = ModuleClass | DynamicModule;

interface DynamicModule extends ModuleOptions {
  readonly module: ModuleClass; // identity for dedupe
}
```

`collectModules` dedupes on `module` while merging registrations. The
duplicate-binding check in [injector.ts](../packages/core/src/di/injector.ts) is
unaffected and still names both modules. Small change; large blast radius if
deferred, because it also changes the `imports` type.

### 3. Custom param decorators

`createParamDecorator` is a Nest extensibility point with **no successor
designed**. The reference app has 14 usages across `@CurrentUser` and
`@UuidParam`.

`@Body`/`@Query`/`@Param` are already answered - schemas move onto the route
decorator (ARCHITECTURE.md, "Params without parameter decorators"). Custom ones
are not, because they read state a guard put there.

The natural shape, given item 1, is that middleware writes onto a typed
per-request context the handler receives:

```ts
@Get('/me', { auth: true })
getMe(req: BunRequest, ctx: Ctx<{ user: User }>) {
  return this.#users.findById(ctx.user.id);
}
```

This needs a decision and belongs in ARCHITECTURE.md before Phase 3 code is
written, since it shares a signature with validated input.

## Roadmap impact

Two changes to the phase order in ARCHITECTURE.md follow from the reference app:

**Route metadata joins Phase 2.** It is not a Phase 3 concern. Guards are the
single most-used cross-cutting feature in the reference app (19 usages across
`@Roles`/`@Public`/`@UseGuards`), and the `Middleware` signature must be final
before `@dunx/http` has consumers.

**OpenAPI is promoted ahead of Phase 4.** ARCHITECTURE.md defers it to Phase 5
as a documentation nicety. In the reference app it is load-bearing: the admin CMS
is _driven by_ the generated document (`NestJsCmsModule.setup(app, document, …)`),
as is the Scalar reference. An app that cannot emit an OpenAPI document cannot
migrate at all.

The upside is that dunx should generate a **better** document than Nest does.
Nest reconstructs schemas from `emitDecoratorMetadata` plus ~80 `@Api*`
decorators precisely because the type information is lossy. dunx has the actual
schema object on the route decorator, so `z.toJSONSchema` produces the document
with no parallel decorator set to maintain.

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

These two are the honest gate on whether any given Nest app can move today.

## Suggested next artifact

`examples/nest-parity` - a stripped port of the reference app: config module,
async database factory, one CRUD controller, an auth guard reading `@Roles`, and
a health endpoint.

`examples/full` cannot surface any of the blocked items above; it has no
controller metadata, no dynamic module, and no validation, so all three gaps are
invisible in the one app CI actually boots. A parity example turns this document
from a list of claims into a build target.
