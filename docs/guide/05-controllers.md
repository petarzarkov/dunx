# Controllers

A controller is a provider with routes on it. It is constructed by the container
like anything else, injects like anything else, and the only thing that
distinguishes it is being listed in a module's `controllers` rather than its
`providers`.

```ts
import { Controller, Get, Post, type Input } from '@dunx/http';
import { z } from 'zod';
import { UsersService } from './users.service.js';

const createUser = { body: z.object({ name: z.string().min(1) }) } as const;
const oneUser = { params: z.object({ id: z.coerce.number().int() }) } as const;

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('/')
  list(): Promise<readonly User[]> {
    return this.users.findAll();
  }

  @Get('/:id', oneUser)
  one({ params }: Input<typeof oneUser>): Promise<User | null> {
    return this.users.find(params.id);
  }

  @Post('/', createUser)
  create({ body }: Input<typeof createUser>): Promise<User> {
    return this.users.create(body.name);
  }
}
```

Three routes, mounted at `GET /users`, `GET /users/:id` and `POST /users`. The
last one answers 201.

## Bun does the routing

`Bun.serve({ routes })` handles path parameters, per-method dispatch, static
`Response` values and 404-on-method-miss in native Zig. dunx ships no router.
`@dunx/http` builds the `routes` object at boot and hands it to Bun.

Four consequences worth knowing about.

**An unmatched method returns 404, where most frameworks return 405.** dunx always
installs the `fetch` fallback described below. A request for a known path with the
wrong method goes to that fallback, runs the global middleware and gets the same
404 as an unknown path:

```
GET     /thing   200   the route
OPTIONS /thing   ->    the fallback
POST    /thing   ->    the fallback
GET     /nope    ->    the fallback
```

The status is 404 either way; what differs is that your middleware sees it, so
request logging, throttling and CORS all get a look at a method miss.

**Paths are matched exactly, so a trailing slash is a different path.** `GET /t`
is a 200 and `GET /t/` is a 404. The same goes for `/t/sub/` and `POST /t/`.
Nest, Express and Elysia accept both spellings; Fastify and Hono do not. A
client ported from one of the first three hits a 404 that reads like a missing
route.

The declared side is already normalised: `@Get('/')` inside `@Controller('t')` is
`/t`, never `/t/`, so both spellings are never live at once. Route discovery
strips it too, so `@Get('sub/')` is `/t/sub`.

`strict: false` serves both:

```ts
const app = await HttpFactory.create(AppModule, { strict: false });
```

It registers a second key ending in `/`, pointing at the handlers the first one
already has, so the request log, the metrics series and the OpenAPI document all
still say `/t/:id`. Every route gets one except `/` and a wildcard mount, which
already matches its own trailing slash.

`strict` defaults to `true`, which matches how `Bun.serve` and Hono behave. For
a client you do not control, a reverse-proxy rewrite in front of dunx also works.

**CORS preflight is mounted, not inferred.** `enableCors()` mounts an explicit
`OPTIONS` handler per path; see
[Why preflight is mounted per path](./08-middleware-and-guards.md#why-preflight-is-mounted-per-path).

**A route collision is a boot error.** Bun silently lets one route win, so dunx
rejects a duplicate method-and-path pair before it can, naming both handlers:

```
Route collision: GET /users/:id is declared by UsersController.one and by
LegacyController.show. Bun would keep only one of them.
```

The check runs twice: at `create()` on the discovered paths, and again at
`listen()` on the final prefixed ones.

### The `fetch` fallback

A dunx application has exactly one `fetch` handler, and it does no routing. Bun
answers an unmatched path itself, so without the fallback nothing in the
middleware chain would see a 404, leaving it invisible to request logging,
metrics and tracing.

`listen()` installs a fallback that runs the global middleware and returns
`{"error":"NOT_FOUND","status":404}`. It runs only after Bun has decided nothing
matched, so Bun still does every bit of the matching.

Global guards also run on a miss. With the default, `notFound: 'public'`, a miss
counts as `@Public()`, so a guard that honours `@Public()` lets the 404 through.
With `HttpFactory.create(root, { notFound: 'guarded' })`, the miss has no route
metadata and the guard rejects it. A caller then cannot tell a missing path from a
protected one.

## How routes are found

There is no registry and nothing accumulates at class-definition time. A method
decorator sets a symbol property on the function it receives and returns it. At
boot, after the container has constructed the controller, the adapter walks the
instance's prototype chain and collects every marked method.

Five things fall out of doing it that way, and each one is a paper cut you will
never hit:

**No class decorator is required.** `@Controller` supplies a prefix and may be
omitted entirely. There is no `@Routes()` to remember, because nothing needs
closing.

**No import-order dependence and no cross-file leak.** An accumulator records
routes as files evaluate; inspection reads what is there when it is asked.

**Overriding a decorated base method works without re-decorating.** The route
comes from the base method's decorator, and requests call the override, because
the handler is looked up on the constructed instance.

**Most-derived wins on a repeated name.** An undecorated override does not shadow
its decorated base out of existence.

**The prefix is inherited.** `prefixOf` reads through the prototype chain, so two
subclasses of one decorated base collide loudly at boot instead of silently
mounting at the root.

### A generic base controller

Routes declared on an abstract base are served by every subclass. A subclass
picks which of them it serves with `include` and `exclude`, by handler name.
`include` applies first, then `exclude`:

```ts
abstract class CrudController<T extends Row> {
  constructor(private readonly store: CrudStore<T>) {}

  @Get('/')
  getList(): readonly T[] {
    return this.store.list();
  }

  @Delete('/:id', byId)
  remove({ params }: Input<typeof byId>): { removed: boolean } {
    return { removed: this.store.remove(params.id) };
  }
}

@Controller('colors', { exclude: ['remove'] })
class ColorsController extends CrudController<Color> {
  constructor(store: ColorsStore) {
    super(store);
  }
}
```

The filter belongs to the class, not to a constructor argument. OpenAPI, the
dashboard and `@dunx/mcp` read routes without constructing the controller, so a
filter passed to `super()` would never reach them.

A method name the class does not have fails to compile. A method that is not a
route fails at boot. Subclasses inherit the filter, and a subclass that applies
`@Controller` again replaces it. `examples/full/src/crud/` has the full example.

The same options object takes `version`, which serves the controller at
`/v1/...` once URI versioning is on. See [Versioning](./34-versioning.md).

A class in `controllers` with no routes at all is a boot error:

```
HealthService is registered as a controller but declares no routes. Add a
@Get/@Post/... method, or move it to providers.
```

## The verbs

`@Get`, `@Post`, `@Put`, `@Patch`, `@Delete`. Each takes a path, defaulting to
`/`, and an optional options object:

```ts
@Get()                          // GET  <prefix>/
@Get('/active')                 // GET  <prefix>/active
@Get('/:id', oneUser)           // GET  <prefix>/:id, with a params schema
@Post('/', createUser)          // POST <prefix>/
```

The controller prefix and the method path are joined and normalised: duplicate
slashes collapse and a trailing slash is stripped, so `@Controller('users/')` plus
`@Get('/')` is `/users`.

The path may also be a **thunk** (`RoutePath` is `string | (() => string)`), read
at route discovery rather than at decoration.

Use a thunk when the path comes from configuration. Decorator arguments run when
the class loads, before configuration exists. Route discovery runs later, after
every provider is ready. `OpenApiModule.forRootAsync` uses this to mount its page
at the path from `ConfigService`. A thunk must return the same path every time.

There is no `@Options` and no `@Head`. `HttpMethod` is
`'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'`, and `OPTIONS` is reserved for the
CORS preflight handler.

`@Sse` mounts a `GET` as well, for a response that stays open. See
[Server-sent events](#server-sent-events).

## Path parameters

Bun's own syntax, because Bun does the matching. Without a `params` schema they
arrive as strings on `req.params`:

```ts
@Get('/:name')
one({ req }: Input<RouteSchemas>): { greeting: string } {
  return { greeting: `hello, ${req.params['name'] ?? 'world'}` };
}
```

Declare a `params` schema and they arrive typed, validated and coerced on
`params`:

```ts
const oneUser = { params: z.object({ id: z.coerce.number().int().min(1) }) } as const;

@Get('/:id', oneUser)
async one({ params }: Input<typeof oneUser>): Promise<User> {
  // Already a number. The schema coerced it before this ran.
  const user = await this.users.find(params.id);
  if (user === null) {
    throw new HttpError(HttpStatusCode.NOT_FOUND, `No user ${params.id}`);
  }
  return user;
}
```

`z.coerce` is where `:id` stops being a string. Path parameters are always strings
on the wire, so a schema that expects a number without coercion will reject every
request.

## Declared input

The second argument to a verb is a [`RouteSchemas`](./06-validation.md#routeschemas)
object declaring what the route accepts. Declaring a schema is what makes the
matching field exist, get parsed and get validated; omitting one means the
framework never touches it.

| Field    | Source                                   | Present when      |
| -------- | ---------------------------------------- | ----------------- |
| `req`    | the `BunRequest`, with `req.cookies`     | always            |
| `body`   | parsed by `content-type`, then validated | `body` declared   |
| `query`  | the query string, then validated         | `query` declared  |
| `params` | `req.params`, then validated             | `params` declared |

Reading and setting a cookie is `req.cookies`; see [Cookies](./35-cookies.md).

The parameter takes either shape. Destructuring is the usual one, and a handler
that passes the request on names the whole object instead:

```ts
@Post('/', createNote)
create({ body }: Input<typeof createNote>): Note {
  return this.notes.add(body.text);
}

@Post('/', createNote)
record(input: Input<typeof createNote>): Note {
  return this.audit.write(input);
}
```

You must write the `Input<...>` annotation. Do not annotate the options constant
as `: RouteSchemas`. [Validation](./06-validation.md#why-input-must-be-written-out)
shows the compiler errors and explains why. For a route with no options, annotate
`Input<RouteSchemas>` or take no parameter.

Any [Standard Schema](./06-validation.md#standard-schema-is-the-contract)
validator works. How each `content-type` is parsed, and the 400 a rejected schema
produces, are in [Validation](./06-validation.md#bodies) as well.

## Returning values

| Handler returns       | Response                                   |
| --------------------- | ------------------------------------------ |
| a `Response`          | passed through untouched, the escape hatch |
| `undefined` or `null` | **204**, no body                           |
| anything else         | `Response.json(value)` at the status below |

There is no `res` and nothing to forget to send. Return a `Response` directly to
stream, to redirect, or to set an unusual content type; it is never
second-guessed.

`undefined` and `null` become 204 rather than `Response.json(null)`.

With `etag: true` a returned value gets an `ETag` and a 304 on revalidation; see
[ETags and conditional GET](./15-caching.md#etags-and-conditional-get).

A handler may be synchronous or return a promise. Both work, and the synchronous
case is genuinely faster; see [The fast path](#the-fast-path).

### Status codes

Precedence: `options.status`, else **201 for POST**, else **200**. That is the usual
rule, kept because it is the one people already know.

```ts
// 201, by virtue of being a POST.
const createUser = { body: CreateUser } as const;

// 201, said out loud. Identical behaviour, clearer at the call site.
const createNote = {
  body: CreateNote,
  status: HttpStatusCode.CREATED,
} as const satisfies RouteSchemas;

// 202, because a POST that queues work is not a POST that created something.
const enqueue = { body: Job, status: HttpStatusCode.ACCEPTED } as const;
```

`HttpStatusCode` is a frozen object with a matching union type, not an enum.
`HttpStatusCode.CREATED` is both a value and the literal type `201`.
`HttpStatusName` is the union of the names.

A thrown `HttpError` still goes through the error mapper, so `status` only sets
the _success_ status.

## Server-sent events

`@Sse(path)` mounts a `GET` answering `text/event-stream`. The handler returns an
`AsyncIterable<SseEvent>`:

```ts
import { Controller, Sse, type SseEvent, type SseInput } from '@dunx/http';
import type { RouteSchemas } from '@dunx/http';

@Controller('jobs')
export class JobsController {
  @Sse('/progress')
  async *progress(input: SseInput<RouteSchemas>): AsyncGenerator<SseEvent> {
    for (let step = 0; step <= 100; step += 25) {
      yield { data: { step }, id: String(step) };
      await Bun.sleep(250);
    }
  }
}
```

The response carries `content-type: text/event-stream`,
`cache-control: no-cache, no-transform` and `connection: keep-alive`. `data` is
serialised with `JSON.stringify` unless it is already a string, and a payload
spanning several lines becomes one `data:` line each; `event`, `id` and `retry`
precede it.

`input.lastEventId` is the `Last-Event-ID` header a reconnecting client sends,
holding the `id` of the last event it saw. `input.req.signal` aborts when it goes
away.

A handler may return an `SseStream` instead, for a feed driven by something other
than a loop:

```ts
@Sse('/alerts')
alerts(): SseStream {
  const stream = new SseStream({ heartbeatMs: 30_000 });
  this.alerts.on((alert) => stream.send({ data: alert, event: 'alert' }));
  return stream;
}
```

A comment line goes out every `heartbeatMs`, 15,000 by default, so a proxy
counting idle seconds sees bytes; `0` sends none. A disconnect cancels the
response body, which closes the stream and clears that timer.

`Bun.serve` severs a request that goes 10 seconds without traffic, a response
already streaming included. `@Sse` marks its route so that limit is
cleared for every stream it answers with, so an idle feed stays up. A handler
streaming from a plain `@Get` declares the same thing with `meta(STREAMS, true)`,
and `idleTimeout` on `HttpFactory.create` moves the limit for the whole server.

`Compression` never encodes `text/event-stream`, and `no-transform` says the same
thing to any proxy in front: gzip holds every frame until the stream ends, so an
encoded event stream arrives all at once or not at all.

The outbound half reads one. `HttpService.streamSse()` in `@dunx/http/client`
yields the `data` payload of each event, and `streamSseEvents()` yields the whole
message, `event`, `id` and `retry` included.

## Errors

Throw `HttpError` for anything the caller should see:

```ts
import { HttpError, HttpStatusCode } from '@dunx/http';

throw new HttpError(HttpStatusCode.NOT_FOUND, 'No such user');
```

`HttpError.status` is a plain `number`, so a status `HttpStatusCode` does not list
is still expressible. It extends `AppError`, and it accepts an `ErrorOptions` third
argument, so `{ cause }` works.

The default mapper produces three shapes:

```jsonc
// ValidationError
{ "error": "Invalid body", "status": 400, "issues": [ ... ] }

// any other HttpError
{ "error": "No such user", "status": 404 }

// anything else: logged through the bound Logger, and the message is not leaked
{ "error": "Internal Server Error", "status": 500 }
```

The last line is the one that matters for security. An unrecognised throw is a
500 with a fixed body. Your message, your stack and your database error text do
not reach the client.

The stack does reach **the log**, through the same `Logger` everything else uses:
`@arkv/logger` in a service that imported `@dunx/infra/logger`, core's
`ConsoleLogger` otherwise. One entry, one line, sanitized like the rest.

An `HttpError` is not logged by the mapper at all. Its status is the whole
record, and request logging has already written the 4xx line.

Replace the whole mapper with `HttpOptions.onError`:

```ts
const app = await HttpFactory.create(AppModule, {
  onError: (error, req) => {
    if (error instanceof DomainConflict) {
      return Response.json(
        { error: error.message, status: 409 },
        { status: 409 },
      );
    }
    return defaultErrorMapper(error, req);
  },
});
```

`onError` takes one handler for the whole application, passed to `create()`:
dunx has one error mapper rather than an exception filter hierarchy. A bare
`ErrorMapper`, `(error: unknown, req: Request) => Response`, suits a mapper that
injects nothing.

To inject the app's `Logger` or config, pass an
[`ErrorFilter`](./08-middleware-and-guards.md#errorfilter-when-the-mapper-needs-dependencies)
subclass instead. `onError` accepts a class and resolves it from the container.
To handle errors for only some routes, write middleware that wraps `next()` in a
`try`.

CORS headers are applied _outside_ the mapper, so a mapped 500 still carries the
headers the browser needs in order to display it.

## Application-level configuration

`create()` boots the container and discovers routes. `listen()` is what builds the
`Bun.serve` route table. Everything between the two still gets to shape it:

```ts
const app = await HttpFactory.create(AppModule);
app.setGlobalPrefix('api');
app.use(AuditMiddleware);
app.set('trust proxy', true);
app.enableCors({ origin: 'https://example.com', credentials: true });
await app.listen(3000);
```

| Hook                   | Effect                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| `setGlobalPrefix(p)`   | Prefixes every discovered route. Slashes normalised, last call wins |
| `use(...middleware)`   | Appends container-resolved `Ctor<Middleware>`, so it can inject     |
| `set(key, value)`      | Typed settings; a key must exist on `AppSettings`                   |
| `setting(key)`         | Reads one back                                                      |
| `enableCors(options?)` | Response headers plus an `OPTIONS` preflight per path               |
| `clientIp(req)`        | The `ClientAddress` singleton, honouring `'trust proxy'`            |
| `listen(port?)`        | Builds the table and binds. A second call throws                    |

Calling any of them **after** `listen()` throws:

```
setGlobalPrefix() must be called before listen(). The route table and the
middleware chain are folded into one closure per route when the server binds, so
this call could not take effect.
```

A trade against the alternative, which is a silent no-op.

`setGlobalPrefix` only moves controller routes. A WebSocket gateway keeps the
exact path it declared. Duplicate routes are already reported at `create()`, and
adding the same prefix to every route cannot create a new duplicate.

`set` is typed against the `AppSettings` interface rather than being a string bag,
so a typo is a compile error rather than a setting that silently never applies.
There is one key today: `'trust proxy'`, typed `boolean | number`.

- The value is how many proxies sit in front of the server, `true` meaning one.
- The address is taken that many entries from the **right-hand** end of
  `X-Forwarded-For`. A direct client can put anything in the header it sends, so only
  the entries a proxy appended carry weight.
- A count higher than the number of proxies you run hands the caller its own choice
  of address.

## Middleware, guards and metadata

dunx has one extension point, the `Middleware` interface. A guard is middleware
that throws, an interceptor wraps `next()`, a pipe is a schema in the route
options and a filter is the error mapper.

`@UseGuards` attaches middleware to a
controller or a route, `@Roles`, `@Public` and `meta` declare route metadata a
guard reads through `ctx.get`, and `@Module({ middleware })` scopes middleware to
one module's routes. All of it, with the request lifecycle, is in
[Middleware and guards](./08-middleware-and-guards.md).

## The fast path

A route with **no middleware and no CORS** is dispatched by a handler in which
nothing is `async`. It returns a `Response` rather than a `Promise<Response>`
wherever it has nothing to wait for, and Bun accepts either.

Every other route runs
`async (req) => toResponse(await handler(await read(req)))` inside an `async`
try/catch. That is four awaits across two async functions, usually on values that
are not promises. Skipping them adds about 6 points of throughput, measured as a
share of raw `Bun.serve`, on the `params` benchmark, and about 5 more on
`validate`.

A route with no schemas, or with only `query` or `params` schemas, awaits nothing,
because common Standard Schema validators are synchronous. A `body` route must
wait for `req.json()`, and pays one promise step instead of six async functions.
A handler or validator that returns a promise still works.

**Adding middleware puts a route back on the async path**, because middleware is
`async`. That includes request logging, which is on by default. A middleware that
only calls `next()` costs 0.05 µs. The 6 points from the fast path do not come
back as a cost, because such a request already pays for the rest of its
middleware.

What remains of dunx's own per-request cost is dispatch. A dunx route whose
handler does its own parsing costs about 1.17 µs over the identical raw
`Bun.serve` handler, and the declared-input reader adds nothing measurable on top
of doing the same work by hand.

Removing that last microsecond would mean generating code per route and running
it with `eval`, as Elysia does. dunx does not do this: the cost is 1.3 µs on a
request whose parsing alone takes 2.9 µs.

## Request logging

`@dunx/http` installs `RequestLoggingMiddleware` by default, writing one entry per
request, unmatched paths included. Turn it off with
`HttpFactory.create(root, { requestLogging: false })`; the options are in
[Middleware and guards](./08-middleware-and-guards.md#request-logging).

## Next

[Validation](./06-validation.md) for the schemas a route declares.
[Middleware and guards](./08-middleware-and-guards.md) for what runs around a handler.

[WebSockets](./09-websockets.md) covers gateways, which share the same `Bun.serve`
server. [Providers](./03-providers.md) and [Modules](./04-modules.md) cover how
controllers are built and grouped. The
[`@dunx/http` reference](../../packages/http) documents the client-address resolver.
