# Middleware and guards

Frameworks in this lineage tend to ship five concepts - middleware, guards, interceptors, pipes and filters -
five base classes, five places to look when a request does something unexpected.
dunx has one.

```ts
export interface Middleware {
  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response>;
}

export type Next = () => Promise<Response>;
```

That is the entire extension point. A guard is middleware that throws. An
interceptor is middleware that wraps `next()`. A pipe is a schema on the route
decorator, covered in [Validation](./06-validation.md). A filter is the error
mapper, one function for the whole app.

## Writing one

A middleware is a class, resolved from the container like anything else, so it has
constructor injection with no annotation:

```ts
import type { BunRequest } from 'bun';
import type { Middleware, Next, RouteContext } from '@dunx/http';

export class RequestLog {
  readonly entries: string[] = [];
}

export class RequestLoggerMiddleware implements Middleware {
  constructor(private readonly log: RequestLog) {}

  async handle(
    req: BunRequest,
    ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    const response = await next();
    this.log.entries.push(
      `${req.method} ${new URL(req.url).pathname} -> ${response.status} ` +
        `(${ctx.controller}.${ctx.handler})`,
    );
    response.headers.set('x-handled-by', 'request-logger');
    return response;
  }
}
```

Install it globally, either at boot or before `listen()`:

```ts
const app = await HttpFactory.create(AppModule, {
  middleware: [RequestLoggerMiddleware],
});
// or, equivalently, appended after the ones above:
app.use(RequestLoggerMiddleware);
```

Both take **classes**, not instances. The class is what the container resolves,
which is what gives the middleware its dependencies. `app.use()` after
`listen()` throws, and so does every other configuration call: the chain is folded
into one closure per route when the server binds, so a later call could not take
effect and being told is better than being ignored.

Global middleware goes on `HttpFactory.create` or `app.use()`, never on `@Module`.
The dunx container is flat and has no module boundary, so "module middleware"
could only ever mean global middleware; hanging it off a module would imply a
scope that does not exist.

## Why `next()` is a function you call, not a hook you implement

This is the design decision the rest of the page follows from.

Because `handle` receives `next` and returns whatever it wants, **one class sees
both halves of a request**. It can time the call, catch the error, rewrite the
response, or refuse to call `next()` at all. Splitting that across two base
classes: middleware runs before, an interceptor wraps the observable, and they
are separate objects with no shared frame, so correlating the two halves means
threading a request id through and reassembling the pair in a log aggregator.

The built-in request logger is the proof. It is one class, and it emits **one
structured entry per request** carrying the request and the response together:

```ts
return this.context.runWithContext(
  { requestId, method: ctx.method, event: path, flow: 'http', context: `${ctx.controller}.${ctx.handler}` },
  () => { ... this.#dispatch(req, path, requestId, started, request, next) },
);
```

Everything the handler logs in between carries `requestId`, `method`, `event` and
`context` without being passed anything, because the whole call runs inside
`runWithContext` on an `AsyncLocalStorage`. There is no pair to correlate, because
there is no pair.

## Ordering

Outermost first:

1. `RequestLoggingMiddleware`, unless `requestLogging: false`
2. `HttpOptions.middleware`, in the order given
3. anything `app.use()` appended, in call order
4. class-level `@UseGuards(...)`, in the order written
5. method-level `@UseGuards(...)`, in the order written
6. the handler

Verified in `packages/http/src/server/guards.test.ts`: a global, a class-level and
a method-level middleware that each push their name produce
`['global', 'class', 'method']`.

The chain is folded at **boot**, not per request:

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

One `reduceRight` per route when the server binds, and after that a request is a
call into a closure. No array iteration, no metadata lookup, no container access
on the request path.

A route with **no middleware and no CORS** skips even that and takes a direct
dispatch path that allocates no async frame unless there is genuinely something to
wait for. Measured on the `plaintext` scenario, that took dunx from 89.5% to 97.2%
of raw `Bun.serve`. The cost of giving it up is small and known: a bare
`next()`-only middleware measures at +0.05 µs per request. Install the middleware
you need and do not think about it further.

## `RouteContext`

The second argument tells a middleware which route it is running for and what that
route's decorators declared:

```ts
export interface RouteContext {
  readonly controller: string;
  readonly handler: string;
  readonly method: HttpMethod;
  readonly path: string;
  get<T>(key: MetaKey<T>): T | undefined;
}
```

One frozen object per route, built when the table is built and closed over by the
chain, so every request to that route sees the identical object. `get` is a `Map`
lookup over a record that was already merged at discovery, not a prototype walk.

### Route metadata

`metaKey` mints a unique symbol; `meta` writes a value onto a class or a method.
Both are exported, and that is the whole mechanism:

```ts
import { meta, metaKey, type MetaKey } from '@dunx/http';

export const TENANT: MetaKey<string> = metaKey<string>('tenant');
export const Tenant = (name: string) => meta(TENANT, name);
```

`@Roles(...)` and `@Public()` are wrappers over exactly this, and `ROLES` and
`PUBLIC` are exported so your own guard can read what they set. `@ApiDoc` in
`@dunx/openapi` is a third wrapper over the same channel, which is why
documentation needs no parallel registry.

A fresh `Symbol()` per `metaKey` call means two libraries that both name a key
`roles` can never read each other's value. Identity is the symbol, not the string.

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

Refusing a request is `throw`. Allowing it is `return next()`. That is the
difference from a boolean-returning guard, and it buys two things: the guard says
_why_ in the same statement that rejects, and the rejection travels the ordinary
error path so the mapper, the logger and CORS all treat it like any other failure.
A `403` from a guard is `{"error":"Requires one of: admin","status":403}`, not a
generic Forbidden.

**Nothing downstream runs.** `next()` was never called, so no further middleware
executes, the input reader never reads the body, and the handler is never invoked.
(The controller _instance_ already exists: dunx resolves the container eagerly at
`HttpFactory.create()`, so every controller is constructed once at boot and the
handler is a bound method closed over it. A guard prevents the call, not the
construction, and there is no per-request instantiation to prevent.)

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

`@UseGuards` hangs off a class or a method, which are real scopes that do exist,
unlike a module. Guards compose rather than override, which is why they are not a
`MetaKey`: a class-level guard and a method-level guard both run, in that order.

A `@UseGuards` class is resolved through the container (`app.get(guard)`), so a
guard injects exactly like global middleware does, and **one instance is shared by
every route that declares it**.

### Metadata alone decides nothing

`GET /reports` above carries `@Roles('admin')` inherited from the class, and it is
readable through `ctx.get(ROLES)`, but no `RolesGuard` is installed on that route,
so nothing enforces it. That is not a bug: metadata is a declaration, and which
guard reads it is a separate decision. The common shape is one global guard plus
`@Public()` on the routes that opt out:

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

Note that the global guard still _runs_ on a public route. It chose to skip. That
is what makes `@Public()` do something rather than decorate, and it is why
`@dunx/auth`'s `SessionGuard` can be installed globally at all: better-auth's own
sign-in endpoints are `@Public()`, and a sign-in route that needed a session could
never be reached.

## The error mapper

One function, for the whole app:

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

`create()` builds it from the **bound** `Logger` when `onError` is absent, so the
stack lands in the same stream, and in the same shape, as everything else the
service writes. `defaultErrorMapper` is the same mapper over core's
`ConsoleLogger`, for the case with no container to ask.

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

There is no per-controller filter and no `@Catch`. One mapper, in one place, and
falling through to `defaultErrorMapper` is the normal way to handle the rest.

### Where the mapper sits

Inside CORS and outside everything else. A mapped 500 still carries the CORS
headers a browser needs in order to _show_ it, which is exactly the case where a
missing header turns a readable error into a silent network failure in the
console.

## Request logging

`@dunx/http` installs `RequestLoggingMiddleware` outermost **by default**. It
injects `Logger` and `RequestContext`, both `@dunx/core` contracts with a default
binding, so it works in an app that imported no logging module at all, and picks
up `@arkv/logger` automatically once `@dunx/infra/logger` is imported.

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
second "received request" line: the pair is precisely the thing being avoided.

Both body options are off for a measured reason. Turning them on costs roughly
two thirds of the throughput on the `validate` benchmark scenario, and the request
body is the field most likely to contain a password. Turn them on in development,
where seeing the payload is the point.

An inbound `x-request-id` is honoured so a trace survives across services - but
only if it is a UUID, because it is caller-supplied and ends up in every line the
request writes. Anything else is replaced by a fresh `crypto.randomUUID()`. Either
way it comes back on the response header, unless the path is in `ignore` and
`correlateIgnored` is off; see
[Logging](./12-logging.md#what-ignore-costs-and-how-to-buy-part-of-it-back).

### The 404 is logged too

`Bun.serve({ routes })` answers an unmatched path itself, which would make every
404 invisible to request logging, metrics and tracing. So `listen()` installs one
`fetch` fallback that puts the global middleware in front of a
`{"error":"NOT_FOUND","status":404}`.

That is **not** a JavaScript router. Bun still does all the matching; the fallback
runs only once Bun has decided nothing matched. The context it gets says
`(unmatched)` for the controller and `(none)` for the handler, which is more
useful in a log line than an empty string, and the response says only
`NOT_FOUND` rather than echoing the path, because an unmatched path is the one
place where repeating the request tells a prober something about the surface it
just failed to find.

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

Four behaviours worth knowing:

- **A disallowed origin gets no CORS headers at all**, rather than an explicit
  denial. That is what makes the browser block it.
- **`*` with `credentials` reflects the caller instead.** A browser rejects the
  pair outright, so the wildcard is quietly turned into the requesting origin.
- **A non-wildcard origin appends `vary: Origin`**, because the response now
  varies by request origin and a shared cache must not serve one origin's copy to
  another.
- **CORS headers are applied outside the error mapper**, so a mapped 500 still
  carries them.

### Why preflight is mounted per path

With `routes` and no `fetch` handler, an `OPTIONS` against a GET-only route is a
**404**, not a 405. Bun's native method miss cannot be intercepted, so a preflight
cannot be inferred:

```
OPTIONS, no fetch handler   -> 404
OPTIONS, with fetch handler -> 418 fell through
```

So `enableCors()` mounts an explicit `OPTIONS` handler on every path, built at
boot from the verbs that path actually declares. It can never collide with one of
your routes, because `HttpMethod` has no `OPTIONS` verb: only CORS mounts one.

## Sharp edges

- **Everything below `listen()` is configuration and throws afterwards.**
  `setGlobalPrefix`, `use`, `set`, `enableCors`. The message says why.
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
  deduplication.
- **`'trust proxy'` is off by default.** Turn it on with
  `app.set('trust proxy', true)` only behind a proxy that rewrites
  `X-Forwarded-For`; a direct client can send whatever it likes.

Next: [WebSockets](./08-websockets.md), which are served by the same `Bun.serve`
call and the same container.
