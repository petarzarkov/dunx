# Middleware and guards

Nest has five request concepts: middleware, guards, interceptors, pipes and
filters. dunx has one, `Middleware`.

```ts
export interface Middleware {
  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response>;
}

export type Next = () => Promise<Response>;
```

That is the entire extension point. A guard is middleware that throws. An
interceptor is middleware that wraps `next()`. A pipe is a schema on the route
decorator, covered in [Validation](./06-validation.md). A filter is the error
mapper, one class for the whole app.

Where a layer comes from - the app, a module, a controller, a method - varies. What
a layer _is_ does not.

## Writing one

A middleware is a class, resolved from the container like anything else, so it has
constructor injection with no annotation:

```ts
import type { BunRequest } from 'bun';
import type { Middleware, Next, RouteContext } from '@dunx/http';

export class RequestTrail {
  readonly entries: string[] = [];
}

export class RequestTrailMiddleware implements Middleware {
  constructor(private readonly trail: RequestTrail) {}

  async handle(
    req: BunRequest,
    ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    const response = await next();
    this.trail.entries.push(
      `${req.method} ${new URL(req.url).pathname} -> ${response.status} ` +
        `(${ctx.controller}.${ctx.handler})`,
    );
    response.headers.set('x-handled-by', 'request-trail');
    return response;
  }
}
```

Install it globally, either at boot or before `listen()`:

```ts
const app = await HttpFactory.create(AppModule, {
  middleware: [RequestTrailMiddleware],
});
// or, equivalently, appended after the ones above:
app.use(RequestTrailMiddleware);
```

Both take **classes** rather than instances, so the container resolves each one
and supplies its dependencies.

`app.use()` after `listen()` throws, as does every other configuration call. The
chain is folded into one closure per route when the server binds, so a later call
could not take effect.

`HttpFactory.create` and `app.use()` are the **app-wide** list. A middleware that
belongs to one feature goes on that feature's module instead - see
[Module middleware](#module-middleware) below.

A middleware class in either list is resolved from the module that declares it
in its `providers`. Your root module does not need to import or re-export that
feature module.

## `next()` is a function you call

`handle` receives `next` and returns whatever it wants, so **one class sees both
halves of a request**. It can time the call, catch the error, rewrite the
response, or not call `next()` at all.

In Nest, code before the handler lives in middleware and code after it lives in an
interceptor. Those are two separate objects, so matching the two halves up means
passing a trace ID between them.

The built-in request logger is one class, and it writes **one structured entry
per request** with the request and the response together:

```ts
return this.context.runWithContext(
  { traceId, spanId, method: ctx.method, event: path, flow: 'http', context: `${ctx.controller}.${ctx.handler}` },
  () => { ... this.#dispatch(req, ctx, path, started, request, next) },
);
```

The whole call runs inside `runWithContext`, which uses `AsyncLocalStorage`. So
every line the handler logs also carries `traceId`, `method`, `event` and
`context`, without you passing them.

## The request lifecycle

Outermost first, and every numbered layer except the last two is the same
`Middleware` interface:

1. the **error filter**, the only layer that turns a throw into a response
2. `RequestLoggingMiddleware`, unless `requestLogging: false`
3. `HttpOptions.middleware`, in the order given
4. anything `app.use()` appended, in call order
5. the **declaring module's** `middleware`, in the order given
6. class-level `@UseGuards(...)`, in the order written
7. method-level `@UseGuards(...)`, in the order written
8. **validation** of `params`, `query` and `body` against the route's schemas
9. the handler

The response then passes back out through 7, 6, 5, 4, 3 and 2. Code after
`await next()` runs on the way out. Use it where Nest would use an interceptor.

`@dunx/http`'s test suite checks this order in one request, in both directions:

```
global:in  use:in  module:in  controller-guard:in  method-guard:in
  validate  handler
method-guard:out  controller-guard:out  module:out  use:out  global:out  log
```

The suite also checks what happens when a guard throws at layer 7:

- validation and the handler do not run
- every outer layer still sees the error on the way out
- the error filter runs last

### If you are coming from Nest

Nest documents nine numbered stages over five base classes. The mapping is not
subtle, because the stages collapse rather than move:

| Nest                                               | dunx                                            |
| -------------------------------------------------- | ----------------------------------------------- |
| Global middleware                                  | `HttpOptions.middleware` / `app.use()`          |
| Module-bound middleware (`configure(consumer)`)    | `@Module({ middleware })`                       |
| Global / controller / route **guards**             | the same list, and `@UseGuards`                 |
| **Interceptors**, pre-controller                   | anything before `await next()`                  |
| **Pipes**, including parameter pipes               | the route decorator's schemas                   |
| Controller handler, then services                  | unchanged                                       |
| **Interceptors**, post-request                     | anything after `await next()`                   |
| **Exception filters**, route → controller → global | `onError`, one filter; or `try` around `next()` |

Four things go away with it:

- No `forRoutes()` path-matching language. A module already owns its controllers.
- No separate `guards`, `interceptors` and `pipes` arrays. They were one
  mechanism wearing three names.
- No ancestor layer. Importing a module never adds middleware to the importer's
  routes.
- No per-controller or per-route filter. A middleware wrapping `next()` in a
  `try` **is** a scoped filter, in the same class that decided to be there.

### Ordering is folded at boot

The chain is composed once per route when the server binds:

```ts
export const compose = (
  middleware: readonly Middleware[],
  ctx: RouteContext,
  handler: RouteHandler,
): RouteHandler =>
  middleware.reduceRight<RouteHandler>(
    (next, current) => (req) => current.handle(req, ctx, () => next(req)),
    handler,
  );
```

This runs once per route at `listen()`. After that, a request is a call into one
prebuilt function: no array loop, no metadata lookup and no container access. A
guard reading route metadata costs a `Map` lookup, where Nest's `Reflector` makes
a reflection call per request.

A route with **no middleware and no CORS** skips even that; see
[The fast path](./05-controllers.md#the-fast-path) and
[Benchmarks](../architecture/benchmarks.md) for what it is worth.

## `RouteContext`

Every middleware in that chain runs against one fixed route. The second
argument tells it which route that is, and what that route's decorators
declared:

```ts
export interface RouteContext {
  readonly controller: string;
  readonly handler: string;
  readonly method: HttpMethod;
  readonly path: string;
  get<T>(key: MetaKey<T>): T | undefined;
}
```

There is one frozen `RouteContext` per route, built at boot, and every request to
that route gets the same object. `get` is a `Map` lookup over the route's
metadata, which was merged at boot.

### Route metadata

`metaKey` mints a unique symbol; `meta` writes a value onto a class or a method.
Both are exported, and together they are the whole mechanism:

```ts
import { meta, metaKey, type MetaKey } from '@dunx/http';

export const TENANT: MetaKey<string> = metaKey<string>('tenant');
export const Tenant = (name: string) => meta(TENANT, name);
```

`@Roles(...)` and `@Public()` are built on these. `ROLES` and `PUBLIC` are
exported so your own guard can read what they set. `@ApiDoc` in `@dunx/openapi`
uses the same mechanism.

A fresh `Symbol()` per `metaKey` call means two libraries that both name a key
`roles` can never read each other's value. The symbol carries the identity.

Resolution is **handler first, then class**, the same direction as the familiar
`getAllAndOverride`. A method-level `@Public()` beats a class-level `@Roles()`.

## Guards

A guard is middleware that throws. There is no `CanActivate`, no boolean return,
no `ExecutionContext`.

```ts
import { HttpError, HttpStatusCode, PUBLIC, ROLES } from '@dunx/http';
import type { Middleware, Next, RouteContext } from '@dunx/http';

export class RolesGuard implements Middleware {
  constructor(private readonly logger: Logger) {}

  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    const required = ctx.get(ROLES);
    if (!required) return next();

    const role = roleOf(req);
    if (role === undefined || !required.includes(role)) {
      throw new HttpError(
        HttpStatusCode.FORBIDDEN,
        `Requires one of: ${required.join(', ')}`,
      );
    }
    return next();
  }
}
```

Refusing a request is `throw`. Allowing it is `return next()`. Compared to a
boolean-returning guard, this buys two things: the guard says _why_ in the same
statement that rejects, and the rejection travels the ordinary error path, so the
mapper, the logger and CORS all treat it like any other failure. A `403` from a
guard is `{"error":"Requires one of: admin","status":403}`.

**Nothing downstream runs.** `next()` was never called, so no further middleware
executes, the input reader never reads the body, and the handler is never
invoked.

The controller instance already exists. Every controller is constructed once, at
`HttpFactory.create()`, so a guard stops the handler call but there is no
per-request construction to skip.

### Scoping a guard

```ts
@Roles('admin')
@Controller('reports')
class ReportsController {
  @Public()
  @Get('/health')
  health() {
    return { ok: true };
  }

  @UseGuards(RolesGuard)
  @Post('/')
  create() {
    return { created: true };
  }

  @Roles('editor')
  @UseGuards(RolesGuard)
  @Get('/draft')
  draft() {
    return { draft: true };
  }
}
```

`@UseGuards` hangs off a class or a method. Guards compose rather than override,
so a class-level guard and a method-level guard both run, in that order. That
composition is why they are not a `MetaKey`.

A `@UseGuards` class is resolved from **the scope of the module that declares the
controller**, so it can inject that module's private providers. One instance is
shared by every route that declares it.

A decorator can install its own guard: `@Idempotent()` is `@UseGuards(IdempotencyGuard)`
plus route metadata, so only the routes that carry it pay for it. See
[Idempotency](./33-idempotency.md).

### Metadata alone decides nothing

A route in `ReportsController` above with no `@UseGuards` still has
`@Roles('admin')` from the class, and `ctx.get(ROLES)` returns it. But no
`RolesGuard` runs on that route, so nothing enforces it. Metadata only takes
effect when a guard reads it. The usual setup is one global guard, plus
`@Public()` on the routes that skip it:

```ts
const app = await HttpFactory.create(AppModule, { middleware: [AuthGuard] });
```

```ts
/** `Authorization: Bearer <role>` - enough to demonstrate, short of a real token. */
const roleOf = (req: BunRequest): string | undefined =>
  req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');

export class AuthGuard implements Middleware {
  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    if (ctx.get(PUBLIC)) return next();
    const role = roleOf(req);
    if (role === undefined) {
      throw new HttpError(HttpStatusCode.UNAUTHORIZED, 'No credentials');
    }
    return next();
  }
}
```

The global guard still runs on a public route. It reads `PUBLIC` and calls
`next()`. `@dunx/auth`'s `SessionGuard` works the same way, so it can be installed
globally: better-auth's sign-in endpoints are `@Public()`, so they are reachable
without a session.

## Module middleware

A guard that only ever made sense for one feature belongs to that feature's module:

```ts
@Module({
  controllers: [ReportsController, ExportsController],
  providers: [ReportsService, TenantPolicy, TenantGuard],
  middleware: [TenantGuard],
  exports: [ReportsService],
})
export class ReportsModule {}
```

`TenantGuard` runs in front of every route in `ReportsController` and
`ExportsController`, and no other routes. It is resolved from `ReportsModule`, so
it can inject `TenantPolicy`, which is not exported and is not visible outside
this module.

Module middleware differs from Nest's `configure(consumer)` in three ways:

**No `forRoutes()`.** Nest matches middleware to paths. A dunx module's middleware
applies to that module's controllers. To cover only some of a module's routes,
put `@UseGuards` on those controllers instead.

**No inheritance.** Importing `ReportsModule` does not put `TenantGuard` in front of
the importer's routes. A module that wants the guard lists it in its own
`middleware`.

**No separate `guards` array.** A guard is middleware that throws, so it goes in
`middleware` too.

A guard that genuinely applies everywhere stays global. `@dunx/auth`'s
`SessionGuard` is that case, and belongs in
`HttpFactory.create(root, { middleware: [SessionGuard] })`.

## The error mapper

A guard's `throw` needs somewhere to land as a response. The error mapper is
that place: one function, for the whole app:

```ts
export type ErrorMapper = (error: unknown, req: Request) => Response;
```

The default:

```ts
export const errorMapper =
  (logger: Logger): ErrorMapper =>
  (error) => {
    if (error instanceof ValidationError) {
      return Response.json(
        { error: error.message, status: error.status, issues: error.issues },
        { status: error.status },
      );
    }
    if (error instanceof HttpError) {
      return Response.json(
        { error: error.message, status: error.status },
        { status: error.status },
      );
    }
    // Any `AppError` that named a status, whoever raised it.
    if (error instanceof AppError && isStatus(error.status)) {
      if (error.status >= 500) logger.error('Unhandled error', error);
      return Response.json(
        { error: error.message, status: error.status },
        { status: error.status },
      );
    }
    logger.error('Unhandled error', error);
    return Response.json(
      {
        error: 'Internal Server Error',
        status: HttpStatusCode.INTERNAL_SERVER_ERROR,
      },
      { status: HttpStatusCode.INTERNAL_SERVER_ERROR },
    );
  };
```

When you pass no `onError`, `create()` builds this mapper with your app's bound
`Logger`, so error stacks go to the same place and in the same format as your
other logs. `defaultErrorMapper` is the same mapper using core's `ConsoleLogger`,
for code that has no container to get a logger from.

An `HttpError` is trusted: its status and its message reach the caller, because a
`404 No user 7` is information the caller is entitled to. Anything else is
**not** trusted: it is logged in full and answered with a bare 500, because an
unexpected error's message is as likely to contain a connection string as a
diagnosis.

Replace it wholesale:

```ts
const app = await HttpFactory.create(AppModule, {
  onError: (error, req) => {
    if (error instanceof TenantMissing) {
      return Response.json(
        { error: 'Unknown tenant', status: 404 },
        { status: 404 },
      );
    }
    return defaultErrorMapper(error, req);
  },
});
```

Falling through to `defaultErrorMapper` is the normal way to handle the rest.

### An error is mapped by whoever raised it

`AppError` carries an optional `status`, and that is how a package with no business
importing the web layer still says what its failure means:

```ts
export class CursorError extends AppError {
  override readonly name = 'CursorError';
  override readonly status = 400;
}
```

`@dunx/infra` does not import `@dunx/http`, so it cannot throw an `HttpError`.
It sets `status` on its own error instead, and the default mapper uses it.
`CursorError` and `PageOptionsError` in `@dunx/infra/pagination` do this, so a
bad cursor returns 400 without any `catch` in your app.

Two details that follow from where the number is set:

- **A 4xx is not logged as an incident.** It is the caller's mistake, and logging
  one at error level is how a log fills with entries nobody can act on. A status of
  500 or above still logs.
- **The value is range-checked.** It is set by hand in a package that never sees a
  `Response`, so a typo would otherwise reach `Response.json` as `status: 4000` and
  throw a `RangeError` from the error path itself. Anything outside 200 to 599 falls
  back to a 500.

An `AppError` with no status is a 500 with its message withheld, which is the right
answer for something like `CircularDependencyError`: a boot failure is not a
response.

### `ErrorFilter`, when the mapper needs dependencies

A mapper is a function, so it cannot inject anything. Use a class when the
mapper needs the app's config or its `Logger`.

`onError` also takes a **class**, resolved from the container like any middleware:

```ts
import { ErrorFilter } from '@dunx/http';

export class AppErrorFilter extends ErrorFilter {
  constructor(
    private readonly logger: Logger,
    private readonly config: AppConfigService,
  ) {}

  catch(error: unknown, req: Request): Response {
    if (error instanceof TenantMissing) {
      this.logger.warn('unknown tenant', { path: new URL(req.url).pathname });
      return Response.json(
        { error: 'Unknown tenant', status: 404 },
        { status: 404 },
      );
    }
    return defaultErrorMapper(error, req);
  }
}

@Module({ providers: [AppErrorFilter] })
export class AppModule {}

const app = await HttpFactory.create(AppModule, { onError: AppErrorFilter });
```

`abstract class` rather than an interface, so it is a runtime value and therefore an
injection token an app can rebind. Extending it is optional - the check is
structural, so any class with a matching `catch` is accepted. The method is named
`catch` to match the thing it replaces.

### Scoping one, without a second concept

Middleware already is a scoped filter, so there is no separate `@Catch`, no
per-controller filter and no per-route filter:

```ts
export class ReportErrors implements Middleware {
  async handle(
    req: BunRequest,
    ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    try {
      return await next();
    } catch (error) {
      if (error instanceof ReportUnavailable) {
        return Response.json(
          { error: 'Try again shortly', status: 503 },
          { status: 503 },
        );
      }
      throw error;
    }
  }
}
```

To handle errors for one module, list it in
`@Module({ middleware: [ReportErrors] })`. For one controller or one route, put
`@UseGuards(ReportErrors)` on the class or the method. A rethrown error goes to
the next layer out, and finally to `onError`. This replaces Nest's route,
controller and global filters.

### Where the app-wide filter sits

CORS is applied outside the filter. Everything else, including request logging,
runs inside it. So a mapped 500 still has CORS headers, and the browser shows the
error body instead of a generic network failure.

A request that ends in a throw is still logged once. The request logger records
the error's status (an `HttpError`'s `status`, or 500 for anything else) and
rethrows, so the filter builds the response. A custom filter
that maps an unexpected error to something other than a 500 is the one case where
the logged status and the sent status differ; throw an `HttpError` and they agree.

## Request logging

`@dunx/http` installs `RequestLoggingMiddleware` **by default**, as the outermost
middleware. It injects `Logger` and `RequestContext`, which `@dunx/core` always
binds, so it works without any logging module. Import `@dunx/infra/logger` and it
uses `@arkv/logger` instead.

```ts
HttpFactory.create(AppModule, { requestLogging: false }); // remove it
HttpFactory.create(AppModule, { requestLogging: { ignore: ['/health'] } }); // tune it
```

| Option          | Default | Notes                                                        |
| --------------- | ------- | ------------------------------------------------------------ |
| `maxBodyLength` | `2048`  | Longer bodies log as `[N bytes]`. `0` omits them entirely.   |
| `requestBody`   | `false` | Costs a `req.clone().text()` per request.                    |
| `responseBody`  | `false` | Same clone-and-buffer cost on the way out.                   |
| `ignore`        | `[]`    | Exact paths to skip, for a health check polled every second. |

A 4xx logs at `warn`, a 5xx at `error`, everything else at `info`. Do not add a
second "received request" line; the single paired entry is the point.

Both body options are off for a measured reason. Turning them on costs roughly
two thirds of the throughput on the `validate` benchmark scenario, and the request
body is the field most likely to contain a password. Turn them on in development,
where seeing the payload is the point.

An inbound `traceparent` is continued so one trace spans both services, but only
if it parses: it is caller-supplied and ends up in every line the request writes,
so a malformed one is discarded rather than repaired and the request starts a
trace of its own.

Either way the answering span comes back as `traceresponse`, unless the path is in
`ignore` and `correlateIgnored` is off; see
[Logging](./13-logging.md#what-ignore-costs-and-how-to-buy-part-of-it-back).

### The 404 is logged too

An unmatched path reaches the `fetch` fallback described in
[Controllers](./05-controllers.md#the-fetch-fallback), which runs the global
middleware, request logging included.

The context it gets says `(unmatched)` for the controller and `(none)` for the
handler, which reads better in a log line than an empty string. The response says
only `NOT_FOUND` and never echoes the path: on an unmatched path, repeating the
request tells a prober something about the surface it just failed to find.

## CORS

```ts
app.enableCors({
  origin: config.get('corsOrigin'),
  credentials: true,
  exposedHeaders: ['x-handled-by'],
  maxAge: 600,
});
```

| Option           | Default                                 | Notes                                          |
| ---------------- | --------------------------------------- | ---------------------------------------------- |
| `origin`         | `'*'`                                   | A string, a list, or an `(origin) => boolean`. |
| `methods`        | the verbs the path declares             | Only for overriding the derived list.          |
| `allowedHeaders` | echoes `Access-Control-Request-Headers` |                                                |
| `exposedHeaders` | none                                    | What the browser lets script read.             |
| `credentials`    | `false`                                 |                                                |
| `maxAge`         | unset                                   | Seconds the browser may cache the preflight.   |

Four behaviours to expect:

- **A disallowed origin gets no CORS headers at all**, rather than an explicit
  denial. The absent headers are what make the browser block it.
- **`*` with `credentials` reflects the caller instead.** A browser rejects the
  pair outright, so the wildcard is quietly turned into the requesting origin.
- **A non-wildcard origin appends `vary: Origin`**, because the response now
  varies by request origin and a shared cache must not serve one origin's copy to
  another.
- **CORS headers are applied outside the error mapper**, so a mapped 500 still
  carries them.

Security response headers (`Strict-Transport-Security`, `X-Frame-Options`, a
`Content-Security-Policy`) are wrapped the same way, at boot rather than as a
middleware. So is `csrf`, which refuses a cross-site write before the chain
runs. See [Security](./32-security.md).

### Why preflight is mounted per path

When `Bun.serve` has `routes` and no `fetch` handler, an `OPTIONS` request to a
GET-only route returns **404**, where the specification suggests 405. dunx cannot
intercept Bun's built-in method miss, so it cannot answer a preflight there:

```
OPTIONS, no fetch handler   -> 404
OPTIONS, with fetch handler -> 418 fell through
```

So `enableCors()` mounts an explicit `OPTIONS` handler on every path, built at
boot from the verbs that path actually declares. It can never collide with one of
your routes, because `HttpMethod` has no `OPTIONS` verb: only CORS mounts one.

## Sharp edges

- **Configuration calls throw after `listen()`.** These are `setGlobalPrefix`,
  `use`, `set` and `enableCors`. The error message says why.
- **`app.use()` takes classes.** Passing an instance means the container never
  sees it and its dependencies are never injected.
- **A guard that returns `next()` without awaiting is fine** and is the cheaper
  form. Only `await` it when you need the response.
- **A middleware that throws synchronously out of `handle`** is still caught: the
  request logger wraps the `next()` call in a try/catch precisely for that case.
- **`ctx.get` returns `undefined` for a key nothing declared.** There is no
  default and no throw; a guard that requires a key should say so itself.
- **The same guard class declared at both class and method scope runs twice.**
  One instance, two positions in the chain. `@UseGuards` guarantees ordering, not
  deduplication. The same holds for a class listed in `@Module({ middleware })`
  and in `@UseGuards` on one of that module's controllers.
- **Module middleware resolves from its module's scope first**, so it can inject
  private providers. Declare it in the same module's `providers`. A class the
  module cannot see still resolves through the permissive `app.get` lookup, but
  it is then a shared instance built somewhere else.
- **`'trust proxy'` is off by default, and it is a hop count.**
  `app.set('trust proxy', n)` says how many proxies are in front of you, `true`
  meaning one, and the address is read that many entries from the **right** of
  `X-Forwarded-For`. Over-counting lets a caller choose its own address.

Next: [WebSockets](./09-websockets.md), which are served by the same `Bun.serve`
call and the same container.
