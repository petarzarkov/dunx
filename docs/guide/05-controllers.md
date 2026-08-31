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
  one(input: Input<typeof oneUser>): Promise<User | null> {
    return this.users.find(input.params.id);
  }

  @Post('/', createUser)
  create(input: Input<typeof createUser>): Promise<User> {
    return this.users.create(input.body.name);
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

**An unmatched method returns 404 where most frameworks return 405.** Bun answers a
method miss natively only when nothing else can claim the request. dunx always
installs the `fetch` fallback described below, so a method miss reaches it, runs the
whole global middleware chain and comes back as the framework's 404 - the same shape
as an unmatched path. Measured:

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
Most frameworks normalise this, so it is the common break in a ported client. It
shows up as a 404 that reads like a missing route.

The declared side is already normalised: `@Get('/')` inside `@Controller('t')` is
`/t`, never `/t/`, so both spellings are never live at once. Route discovery
strips it too, so `@Get('sub/')` is `/t/sub`.

Send the path without the trailing slash. For a caller you do not control, put
the normalisation in front of dunx, where a reverse-proxy rewrite is one line.

The inbound URL is the only remaining half, and dunx could only touch it in the
`fetch` fallback below. That runs after Bun has matched nothing, so it holds no
patterns to try `/t/7/` against. Matching there would mean a second JavaScript
router beside Bun's.

**CORS preflight is mounted, not inferred.** An `OPTIONS` request does reach the
fallback. Answering preflight there would mean reconstructing which verbs the path
declares, after Bun has already failed to match it.

`enableCors()` mounts an explicit `OPTIONS` handler on every path instead, built at
boot from the verbs that path declares. It cannot collide with one of yours: there is
no `OPTIONS` verb decorator.

**A route collision is a boot error.** Bun silently lets one route win, so dunx
rejects a duplicate method-and-path pair before it can, naming both handlers:

```
Route collision: GET /users/:id is declared by UsersController.one and by
LegacyController.show. Bun would keep only one of them.
```

The check runs twice: at `create()` on the discovered paths, and again at
`listen()` on the final prefixed ones.

A dunx application has exactly one `fetch` handler, and it does no routing. Bun
answers an unmatched path itself, so without the fallback nothing in the
middleware chain would see a 404, leaving it invisible to request logging,
metrics and tracing.

`listen()` installs a fallback that runs the global middleware and returns
`{"error":"NOT_FOUND","status":404}`. It runs only after Bun has decided nothing
matched, so Bun still does every bit of the matching.

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

**Overriding a decorated base method works without re-decorating.** Discovery
finds the base's marker, and dispatch lands on the override, because the handler
is bound off the constructed instance rather than off the prototype.

**Most-derived wins on a repeated name.** An undecorated override does not shadow
its decorated base out of existence.

**The prefix is inherited.** `prefixOf` reads through the prototype chain, so two
subclasses of one decorated base collide loudly at boot instead of silently
mounting at the root.

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

It covers one situation: a path coming out of validated configuration is unknown
when a decorator's arguments are evaluated, and discovery runs after every
provider has settled. `OpenApiModule.forRootAsync` is the caller, mounting its
page where `ConfigService` says. A thunk must answer the same path every call.

There is no `@Options` and no `@Head`. `HttpMethod` is
`'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'`, and `OPTIONS` is reserved for the
CORS preflight handler.

## Path parameters

Bun's own syntax, because Bun does the matching. Without a `params` schema they
arrive as strings on `input.req.params`:

```ts
@Get('/:name')
one(input: Input<RouteSchemas>): { greeting: string } {
  return { greeting: `hello, ${input.req.params['name'] ?? 'world'}` };
}
```

Declare a `params` schema and they arrive typed, validated and coerced on
`input.params`:

```ts
const oneUser = { params: z.object({ id: z.coerce.number().int().min(1) }) } as const;

@Get('/:id', oneUser)
async one(input: Input<typeof oneUser>): Promise<User> {
  // Already a number. The schema coerced it before this ran.
  const user = await this.users.find(input.params.id);
  if (user === null) {
    throw new HttpError(HttpStatusCode.NOT_FOUND, `No user ${input.params.id}`);
  }
  return user;
}
```

`z.coerce` is where `:id` stops being a string. Path parameters are always strings
on the wire, so a schema that expects a number without coercion will reject every
request.

## Declared input

The second argument to a verb declares what the route accepts. Declaring a schema
is what makes the matching `input` field exist, get parsed and get validated;
omitting one means the framework never touches it.

```ts
export interface RouteSchemas {
  readonly body?: StandardSchemaV1;
  readonly query?: StandardSchemaV1;
  readonly params?: StandardSchemaV1;
  /** Overrides the default success status: 201 for POST, 200 otherwise. */
  readonly status?: number;
}
```

| Field          | Source                                   | Present when      |
| -------------- | ---------------------------------------- | ----------------- |
| `input.req`    | the `BunRequest`                         | always            |
| `input.body`   | parsed by `content-type`, then validated | `body` declared   |
| `input.query`  | the query string, then validated         | `query` declared  |
| `input.params` | `req.params`, then validated             | `params` declared |

Validation targets the **Standard Schema** spec (`~standard.validate`), restated
in `@dunx/http`'s own types rather than depended on: the spec is an interface and
`@standard-schema/spec` ships nothing but declarations.

zod 4, Valibot and ArkType therefore drop straight in while `@dunx/http` keeps
zero dependencies. Anything with a `~standard` property qualifies, including a
hand-written object and a bridged compiled checker.

A `~standard.validate` may return a promise and the reader handles that, though
none of zod, Valibot or ArkType ever does. Measured, and it lets a `query`-only
or `params`-only route validate without allocating a promise.

### Why `Input<typeof opts>` has to be written out

A TypeScript limit rather than a design choice, and the one piece of ceremony
dunx could not remove.

A standard method decorator is
`(value: V, ctx: ClassMethodDecoratorContext) => V | void`. It can _reject_ a
mismatched `V`, but it has no way to contextually type an unannotated parameter.
Decorators observe; they do not type. Measured with `tsc`, because this is a
type-level claim `bun` cannot answer:

| Handler                       | Result                                                   |
| ----------------------------- | -------------------------------------------------------- |
| annotated correctly           | compiles                                                 |
| unannotated parameter         | `TS7006: Parameter 'input' implicitly has an 'any' type` |
| annotated with the wrong type | `TS1241` + `TS1270`, naming the mismatched property      |

So the annotation is required. What makes it cheap is that `Input<O>` is a
type-level function over the options object, so every field type still comes from
the schema and nothing is declared twice:

```ts
const createNote = { body: CreateNote, status: HttpStatusCode.CREATED } as const;

@Post('/', createNote)
create(input: Input<typeof createNote>): Note {
  return this.notes.add(input.body.text); // input.body.text is string
}
```

`Input<O>` reads the options object's **declared** type, so the one thing you must
not do is annotate that constant as `RouteSchemas`:

```ts
// Wrong. RouteSchemas.body is optional, so Input<typeof createNote> degrades to
// bare { req } and input.body is a compile error at every handler.
const createNote: RouteSchemas = { body: CreateNote };

// Right. `satisfies` checks the shape without replacing the type.
const createNote = { body: CreateNote } as const satisfies RouteSchemas;
```

`as const satisfies RouteSchemas` is the convention throughout the codebase.
`satisfies` catches a misspelled field at the declaration rather than as a missing
`input` field in the handler, and `as const` keeps `status` a literal. Options
passed inline need neither, because the decorator's own `const O` type parameter
stops them widening on the way in.

For a route with no options, annotate `Input<RouteSchemas>` or take no parameter
at all.

### Body parsing

Only when `body` is declared, and by media type:

| `content-type`                      | `input.body` before validation          |
| ----------------------------------- | --------------------------------------- |
| `application/json`, `*+json`, none  | `req.json()`                            |
| `application/x-www-form-urlencoded` | fields; a repeated key becomes an array |
| `multipart/form-data`               | fields and `File`s, same repeat rule    |
| `text/*`                            | `req.text()`, a string                  |
| anything else                       | **415**, nothing read                   |

A repeated key becoming an array is the same rule for query strings, so `?tag=a&tag=b`
reaches the schema whole instead of silently losing `a`.

A body the caller mangled is a **400** (`Malformed application/json body`), never
a 500. A missing `content-type` reads as JSON, because `fetch` omits the header
for a bodyless request and a 415 there would only hide the schema error that is
about to be more useful.

### Validation failures

A rejected schema is a `ValidationError`, always a 400, and the issues survive
into the response body, because a caller cannot fix what it cannot see. Paths are
flattened to dots, and both zod's bare keys and Valibot's `{ key }` objects render
the same way:

```json
{
  "error": "Invalid body",
  "status": 400,
  "issues": [{ "message": "name must be a non-empty string", "path": "name" }]
}
```

`ValidationError` carries `source`, which is `'body'`, `'query'` or `'params'`,
and `issues`, if you want to remap it in your own error mapper.

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

`HttpStatusCode` is a frozen object plus an indexed-access union rather than an
enum, so `HttpStatusCode.CREATED` is both a value and a narrow type, and erases.
`HttpStatusName` gives you the names.

A thrown `HttpError` still goes through the error mapper, so `status` only sets
the _success_ status.

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

An `ErrorMapper` is `(error: unknown, req: Request) => Response`. There is one per
application and there is no imperative equivalent, so it must be passed to
`create()`. This is the "filters" slot: dunx has one error mapper rather than an
exception filter hierarchy.

`defaultErrorMapper` writes through core's `ConsoleLogger`, because a bare export
has no container to ask. `errorMapper(logger)` is the same mapper over any `Logger`
you hand it, and is what `create()` builds from the bound one when `onError` is
absent. Reach for it when the wrapper above should keep the app's logger rather
than the default:

```ts
import { errorMapper } from '@dunx/http';

const mapper = errorMapper(logger); // whatever LoggerModule was configured with

const app = await HttpFactory.create(AppModule, {
  onError: (error, req) =>
    error instanceof DomainConflict ? conflict(error) : mapper(error, req),
});
```

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

`setGlobalPrefix` moves controller routes only. A WebSocket gateway path is the
exact path it declared. The collision check re-runs on the prefixed paths, though
a uniform prefix cannot introduce a collision the unprefixed paths lacked, so the
early check at `create()` is already complete.

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

One extension point in place of five. Comparable frameworks have middleware,
guards, interceptors, pipes and filters; dunx has a `Middleware` interface, and
the other four fall out of it:

```ts
export interface Middleware {
  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response>;
}
```

A guard is middleware that throws. An interceptor wraps `next()`. A pipe is a
schema in the route options. A filter is the error mapper.

Middleware classes come out of the container, so they inject. Chains are folded
into a single closure per route **at boot**, so there is no per-request array
iteration. Order is global outermost, then class-level `@UseGuards`, then
method-level, then the handler.

`ctx` names the route and carries whatever its decorators declared, resolved once
at discovery with the handler's metadata merged over the class's. `ctx.get(key)`
is therefore a `Map` lookup, and a method-level `@Public()` overrides a
class-level `@Roles()`:

```ts
import {
  HttpError,
  HttpStatusCode,
  PUBLIC,
  ROLES,
  type Middleware,
} from '@dunx/http';

export class AuthGuard implements Middleware {
  constructor(private readonly logger: Logger) {}

  handle(req: BunRequest, ctx: RouteContext, next: Next): Promise<Response> {
    if (ctx.get(PUBLIC)) return next();
    const role = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
    if (role === undefined) {
      throw new HttpError(HttpStatusCode.UNAUTHORIZED, 'No credentials');
    }
    return next();
  }
}
```

```ts
@Roles('admin')
@UseGuards(AuthGuard)
@Controller('reports')
export class ReportsController {
  @Public()
  @Get('/health')
  health(): { ok: true } {
    return { ok: true };
  }

  @UseGuards(RolesGuard)
  @Post('/', createReport)
  create(input: Input<typeof createReport>): readonly string[] {
    return this.reports.add(input.body.title);
  }
}
```

`ROLES` and `PUBLIC` are exported so your own guard can read what `@Roles` and
`@Public` set. They are thin wrappers over the generic channel, and your own key
needs nothing more:

```ts
import { meta, metaKey, type MetaKey } from '@dunx/http';

export const RATE_LIMIT: MetaKey<number> = metaKey('rateLimit');
export const RateLimit = (perMinute: number) => meta(RATE_LIMIT, perMinute);
```

`metaKey` mints a fresh unique symbol per call, so two libraries that both name a
key `roles` never read each other's value.

Middleware has three homes, and which one to use is decided by scope rather than by
kind. App-wide goes to `HttpFactory.create` or `app.use()`. A feature's own goes to
`@Module({ middleware })`, where it covers the routes that module's controllers
declare and nothing else. One controller's or one route's goes to `@UseGuards`.

## The fast path

A route with **no middleware and no CORS** is dispatched by a handler in which
nothing is `async`. It returns a `Response` rather than a `Promise<Response>`
wherever it has nothing to wait for, and Bun accepts either.

This is most of what closed the gap to Elysia. The general path is
`async (req) => toResponse(await handler(await read(req)))` inside an `async`
try/catch: four awaits across two async frames, on values that are usually not
thenable.

Emitting the synchronous shape was worth about 6 points of raw `Bun.serve`
throughput on the `params` scenario, and a further 5 on `validate` once it
covered routes that read input.

A route with no declared schemas awaits nothing. Nor does one with only `query`
or `params`, every Standard Schema validator worth using being synchronous. Even
a `body` route, which must wait for `req.json()`, pays one promise link in place
of six async frames. A handler or validator returning a promise still works and
is adopted rather than awaited.

**Adding middleware opts a route back into the async path**, middleware being
`async` by contract. That includes request logging, which is on by default. A
bare `next()`-only middleware measures 0.05 µs, and the 6 points the direct path
wins on `params` do not reappear as a cost, since the request is already paying
for everything else.

What remains of dunx's own per-request cost is dispatch. A dunx route whose
handler does its own parsing costs about 1.17 µs over the identical raw
`Bun.serve` handler, and the declared-input reader adds nothing measurable on top
of doing the same work by hand.

Removing that last microsecond means generating per-route source and `eval`-ing
it, which is Elysia's approach. At 1.3 µs on a request whose parse alone is
2.9 µs, it is not the next thing worth doing.

## Request logging

`@dunx/http` installs `RequestLoggingMiddleware` by default, outermost in the
chain, writing **one structured entry per request** carrying the request and the
response together. Frameworks without that property need a middleware plus an interceptor, because
they are different classes; dunx does not, because middleware wraps `next()`.

A 4xx logs at `warn` and a 5xx at `error`. Unmatched paths are logged too, through
the `fetch` fallback described above.

Turn it off with `HttpFactory.create(root, { requestLogging: false })`, or pass an
options object to tune what it records. It costs real throughput, and
[Introduction](./01-introduction.md) has the measured numbers and the
decomposition.

## Next

[Providers](./03-providers.md) for how a controller's constructor gets filled in.
[Modules](./04-modules.md) for how controllers are grouped. The
[`@dunx/http` reference](../../packages/http) covers WebSocket gateways, CORS
options and the client-address resolver, none of which are on this page.
