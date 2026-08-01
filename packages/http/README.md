# @dunx/http

`Bun.serve` adapter for [dunx](https://github.com/petarzarkov/dunx). Class-based
controllers **and WebSocket gateways**, standard decorators, and no JavaScript
router — Bun's native `routes` does path params and per-method dispatch in Zig.

`Bun.serve` takes `routes` and `websocket` in one call, so both live here: one
`listen()`, one server, one port. Zero dependencies beyond `@dunx/core` — no
`express`, no `ws`, no `socket.io`.

## Install

```bash
bun add @dunx/http @dunx/core
```

## Usage

```ts
import { inject, Module } from '@dunx/core';
import { Controller, Get, HttpFactory, Post, type Input } from '@dunx/http';
import { z } from 'zod'; // or Valibot, or ArkType, or none at all

const createUser = { body: z.object({ name: z.string() }) } as const;
const oneUser = { params: z.object({ id: z.coerce.number() }) } as const;

@Controller('users')
export class UsersController {
  readonly #users = inject(UsersService);

  @Get('/')
  list() {
    return this.#users.findAll(); // plain values become Response.json()
  }

  @Get('/:id', oneUser)
  one(input: Input<typeof oneUser>) {
    return this.#users.find(input.params.id); // a number, already validated
  }

  @Post('/', createUser)
  create(input: Input<typeof createUser>) {
    return this.#users.create(input.body.name); // 201, no Response.json()
  }
}

@Module({ controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}

const app = await HttpFactory.create(AppModule, { port: 3000 });
app.enableShutdownHooks();
await app.listen();
```

## Typed input

The second argument to any verb declares what the route accepts. Declaring a
schema is what makes the matching `input` field exist, get parsed and get
validated; omitting one means the framework never touches it.

```ts
const createNote = { body: CreateNote, status: HttpStatusCode.CREATED } as const;

@Post('/', createNote)
create(input: Input<typeof createNote>): Note {
  return this.notes.add(input.body.text); // typed, already validated
}
```

`Input<typeof opts>` has to be written out. A standard method decorator can
**check** a handler's parameter type but cannot contextually type an unannotated
one, so the annotation is required — and it is a type-level function over the
options object, so each type is still declared exactly once. A wrong annotation is
a compile error naming the mismatched property; an unannotated parameter is
`TS7006`.

| Field          | Source                                | Declared by |
| -------------- | ------------------------------------- | ----------- |
| `input.req`    | the `BunRequest` — always present     | always      |
| `input.body`   | parsed by `content-type`, then validated | `body`   |
| `input.query`  | `new URL(req.url).searchParams`        | `query`     |
| `input.params` | `req.params`                           | `params`    |

With no options at all, annotate `Input<RouteSchemas>` for the request, or take no
parameter. Path params without a `params` schema stay on `input.req.params`.

Validation is the **Standard Schema** spec (`~standard.validate`, sync or async),
restated in this package's own types — so Zod 4, Valibot and ArkType all work and
`@dunx/http` still has zero dependencies. Anything with a `~standard` property
qualifies, including a hand-written object; see `examples/playground`.

### Body parsing

Parsed only when `body` is declared, by media type:

| `content-type`                      | `input.body` before validation           |
| ----------------------------------- | ---------------------------------------- |
| `application/json`, `*+json`, none  | `req.json()`                             |
| `application/x-www-form-urlencoded` | fields; a repeated key becomes an array  |
| `multipart/form-data`               | fields and `File`s, same repeat rule     |
| `text/*`                            | `req.text()` — a string                  |
| anything else                       | **415**, nothing read                    |

A body the caller mangled is a **400** (`Malformed application/json body`), never a
500. A missing `content-type` reads as JSON, because a 415 there would only hide
the schema error that is about to be more useful.

### Response wrapping

| Handler returns   | Response                                     |
| ----------------- | -------------------------------------------- |
| a `Response`      | passed through untouched — the escape hatch  |
| `undefined`/`null`| `204`, no body                               |
| anything else     | `Response.json(value)` at the status below   |

Status precedence: `options.status`, else **201 for POST**, else **200** — Nest's
rule. A thrown `HttpError` still goes through the error mapper.

### Validation failures

A rejected schema is a `ValidationError` — a `400` whose body carries every issue,
with the path flattened to dots (both `['a', 0]` and `[{ key: 'a' }, { key: 0 }]`
render as `a.0`):

```json
{
  "error": "Invalid body",
  "status": 400,
  "issues": [{ "message": "name must be a non-empty string", "path": "name" }]
}
```

## Route metadata and scoped middleware

A decorator annotates a route; a guard reads the annotation back. Metadata on its
own enforces nothing — which is why `@Roles` needs a guard that looks at it, and
why one global guard plus `@Public()` is the combination worth learning.

```ts
import {
  Controller,
  Get,
  HttpError,
  HttpStatusCode,
  Patch,
  Post,
  Public,
  PUBLIC,
  Roles,
  ROLES,
  UseGuards,
  type Middleware,
  type Next,
  type RouteContext,
} from '@dunx/http';

// Global. `ctx.get(PUBLIC)` is the only thing that can tell an opted-out route
// apart from one that needs credentials.
export class AuthGuard implements Middleware {
  handle(req: BunRequest, ctx: RouteContext, next: Next) {
    if (ctx.get(PUBLIC)) return next();
    if (!req.headers.get('authorization')) {
      throw new HttpError(HttpStatusCode.UNAUTHORIZED, 'No credentials');
    }
    return next();
  }
}

// A guard is middleware that throws. There is no `CanActivate`.
export class RolesGuard implements Middleware {
  handle(req: BunRequest, ctx: RouteContext, next: Next) {
    const required = ctx.get(ROLES);
    if (!required) return next();
    if (!required.includes(roleOf(req))) {
      throw new HttpError(HttpStatusCode.FORBIDDEN, 'Forbidden');
    }
    return next();
  }
}

@Roles('admin') // a class-level default
@Controller('reports')
export class ReportsController {
  @Public() // overrides the class-level @Roles for this route
  @Get('/health')
  health() {
    return { ok: true };
  }

  @UseGuards(RolesGuard) // reads the class-level @Roles('admin')
  @Post('/')
  create(input: Input<typeof createReport>) {}

  @Roles('editor') // the method wins over the class
  @UseGuards(RolesGuard)
  @Patch('/:id')
  rename(input: Input<typeof renameReport>) {}
}

const app = await HttpFactory.create(AppModule, { middleware: [AuthGuard] });
```

### `RouteContext`

The second argument to `handle`. Built **once per route at boot** and closed over
by the chain, so `get` is a `Map` lookup over an already-merged record — not a
prototype walk, and nothing is resolved per request.

| Member         | Is                                                        |
| -------------- | --------------------------------------------------------- |
| `controller`   | The controller class's name                               |
| `handler`      | The method's name                                         |
| `method`       | `'GET' \| 'POST' \| ...`                                  |
| `path`         | The mounted path, prefixes applied                        |
| `get(key)`     | The metadata value, or `undefined`                        |

`get` resolves the **handler's** metadata first and the **controller class's**
second — the same override direction as Nest's `Reflector.getAllAndOverride`.

### Your own keys

`@Roles` and `@Public` are three lines each over the generic setter, and a key of
your own costs the same:

```ts
import { meta, metaKey } from '@dunx/http';

const TENANT = metaKey<string>('tenant');
export const Tenant = (name: string) => meta(TENANT, name);

// …and in a guard: ctx.get(TENANT)
```

`metaKey` mints a fresh symbol per call, so two libraries that both name a key
`roles` never read each other's value. `meta` is valid on a **method or a class**;
there are no parameter decorators in the standard proposal, so there is nothing
else it could attach to.

### Ordering and inheritance

- **Chain order**: global (`HttpOptions.middleware`, then `use()`), then the
  controller's `@UseGuards`, then the method's. Outermost first.
- Guards are resolved **from the container**, exactly like global middleware, so a
  guard gets constructor injection and one instance is shared by every route that
  declares it.
- A subclass inherits its base's class-level metadata and guards, and its own
  additions never reach the base or a sibling: every write copies the record and
  defines an **own** property. Nothing accumulates at class-definition time, so
  there is no ordering dependence and no cross-file leak.
- Two `@UseGuards` on one target read top to bottom. Two of one metadata key read
  bottom-up, so the topmost decorator wins.

## Request logging, on by default

Every request produces **one** structured entry, request and response together:

```json
{
  "level": "info",
  "message": "POST /api/users 201",
  "requestId": "b1f0…",
  "method": "POST",
  "event": "/api/users",
  "flow": "http",
  "context": "UsersController.create",
  "request": { "body": { "name": "ada" }, "userAgent": "curl/8.5.0" },
  "statusCode": 201,
  "responseBody": { "id": 3, "name": "ada" },
  "elapsedMs": 5
}
```

One entry, not two, is the point. Nest logs on the way in from a middleware and on
the way out from an interceptor, because they are different classes and the
interceptor cannot see what the middleware saw. Here they are the same closure, so
there is no pair to correlate by `requestId` to find out how a call ended. A 4xx
logs at `warn`, a 5xx at `error`.

It needs no configuration: `Logger` and `RequestContext` are `@dunx/core`
contracts with default bindings, so this works in an app that imported no logging
module. Import `@dunx/infra/logger` and the same entries go through
`@arkv/logger` — sanitized, masked, optionally to a rotating file — with nothing
here changing.

Everything the **handler** logs in between carries the same `requestId`, `method`,
`event` and `context`, because the whole call runs inside `runWithContext`. An
inbound `x-request-id` is honoured so a trace survives across services; otherwise
one is minted and returned on the response.

```ts
HttpFactory.create(AppModule, { requestLogging: false }); // off
HttpFactory.create(AppModule, {
  requestLogging: { ignore: ['/health'], responseBody: false, maxBodyLength: 512 },
});
```

### Unmatched paths are logged too

`Bun.serve({ routes })` answers a miss itself, so nothing in the middleware chain
would ever see a 404 — invisible to logging, metrics and tracing. `listen()`
installs one `fetch` fallback that runs the global middleware and returns
`{"error":"NOT_FOUND","status":404}`.

This is not a JavaScript router. Bun still does every bit of the matching; the
fallback runs only after it has decided nothing matched.

## App-level configuration

`create()` boots the container and discovers routes; `listen()` is what builds the
`Bun.serve` route table. So everything between the two still gets to affect it:

```ts
const app = await HttpFactory.create(AppModule);
app.setGlobalPrefix('api');
app.use(AuditMiddleware);
app.set('trust proxy', true);
app.enableCors({ origin: 'https://example.com', credentials: true });
await app.listen(3000);
```

Calling any of them **after** `listen()` throws. The route table and the middleware
chain are folded into one closure per route when the server binds, so a late call
could only ever be a silent no-op — the failure mode worth trading for an error.

| Hook                     | Effect                                                                        |
| ------------------------ | ----------------------------------------------------------------------------- |
| `setGlobalPrefix(p)`     | Prefixes every discovered route. Slashes normalised; last call wins           |
| `use(...middleware)`     | Appends container-resolved `Ctor<Middleware>`, so it can inject               |
| `set(key, value)`        | Typed settings — a key must exist on `AppSettings`, so a typo is a type error |
| `setting(key)`           | Reads one back                                                                |
| `enableCors(options?)`   | Response headers plus an `OPTIONS` preflight per path. Last call wins         |
| `clientIp(req)`          | The `inject(ClientAddress)` singleton, honouring `'trust proxy'`              |
| `listen(port?)`          | Builds the table, binds. A second call throws                                 |

### Precedence

- **Middleware order**: `HttpOptions.middleware` first (outermost), then each
  `use()` call in the order it was made, then a controller's `@UseGuards`, then a
  method's — innermost. Outermost sees the request first and the response last.
- **Port**: the `listen(port)` argument, else `HttpOptions.port`, else `3000`.
- **Error mapper**: `HttpOptions.onError`; there is no imperative equivalent.
- **Repeated calls**: `setGlobalPrefix`, `set` and `enableCors` all replace, so the
  last call wins. `use()` appends.
- **Collisions**: rejected at `create()`, and re-checked at `listen()` against the
  final prefixed paths. A uniform prefix cannot introduce a collision the
  unprefixed paths did not already have, which is why the early check is complete.

### CORS and preflight

`Bun.serve({ routes })` answers a method miss with `404`, so a preflight can never
be inferred — `enableCors()` mounts an explicit `OPTIONS` handler on every path,
built at boot from the methods that path actually declares. `origin` takes a
string, a list, or a predicate; anything not allowed gets **no** CORS headers at
all, which is what makes the browser block it. `'*'` is the default, and because a
browser rejects `*` alongside credentials, `credentials: true` reflects the
caller's origin instead. `allowedHeaders` defaults to echoing
`Access-Control-Request-Headers`. Headers are applied outside the error mapper, so
a mapped `500` still carries them.

### Client IP

`ClientAddress` needs no registration — every class is injectable, and `listen()`
hands the resolved singleton the live server:

```ts
export class AuditMiddleware implements Middleware {
  constructor(private readonly address: ClientAddress) {}

  async handle(req: BunRequest, ctx: RouteContext, next: Next) {
    console.log(this.address.of(req));
    return next();
  }
}
```

`of(req)` returns the first `X-Forwarded-For` entry when `'trust proxy'` is set and
the header is present, otherwise `server.requestIP(req)?.address`. Leave the
setting off unless a proxy you control rewrites the header: a direct client can
send whatever it likes.

## WebSocket gateways

A gateway is a normal injectable class declared in `@Module({ providers })` — there
is no second list and no module to configure. `HttpFactory` finds it by its
`@Gateway` marker, and `listen()` mounts it on the same server as the routes:

```ts
import { Module } from '@dunx/core';
import {
  Gateway,
  HttpFactory,
  OnClose,
  OnMessage,
  OnOpen,
  PubSub,
  type Socket,
} from '@dunx/http';

@Gateway('/chat')
export class ChatGateway {
  constructor(private readonly pubsub: PubSub) {}

  @OnOpen()
  opened(socket: Socket) {
    socket.send('welcome');
  }

  @OnMessage('chat.join')
  join(room: string, socket: Socket) {
    socket.subscribe(room); // Bun's own pub/sub
    return { joined: room }; // returned values are replied to the sender
  }

  @OnMessage('chat.say')
  say(payload: { room: string; text: string }) {
    this.pubsub.publishEvent(payload.room, 'chat.said', payload.text);
  }

  @OnClose()
  closed(socket: Socket, code: number) {
    console.log(`${socket.data.path} closed with ${code}`);
  }
}

@Module({ controllers: [NotesController], providers: [ChatGateway] })
export class AppModule {}

const app = await HttpFactory.create(AppModule, {
  websocket: { idleTimeout: 120 },
});
await app.listen(3000); // /notes over HTTP and /chat over WebSocket
```

Constructor injection, `inject()`, `OnInit` and `OnShutdown` all work in a gateway,
because the container builds it like anything else. `app.gatewayPaths` is every
path that upgrades.

### Handlers

| Decorator           | Signature                             | Notes                                                          |
| ------------------- | ------------------------------------- | -------------------------------------------------------------- |
| `@Gateway(path)`    | class                                 | Required — it is what marks the provider as a gateway          |
| `@OnUpgrade()`      | `(req: BunRequest)`                   | Return a `Response` to refuse; anything else becomes `context` |
| `@OnOpen()`         | `(socket)`                            |                                                                |
| `@OnMessage(event)` | `(data, socket)`                      | Routed by envelope event name                                  |
| `@OnMessage()`      | `(message: string \| Buffer, socket)` | The raw catch-all                                              |
| `@OnClose()`        | `(socket, code, reason)`              |                                                                |
| `@OnDrain()`        | `(socket)`                            | Backpressure relieved                                          |
| `@OnPing()`         | `(data, socket)`                      | Bun still answers with a pong                                  |
| `@OnPong()`         | `(data, socket)`                      |                                                                |

Handlers may be `async`. A returned value is sent to the sender — under the same
event name for `@OnMessage(event)`, verbatim (or JSON) for the raw handler, and
never for a lifecycle handler. Return `undefined` to send nothing.

`socket` is Bun's `ServerWebSocket`, unwrapped: `send`, `subscribe`, `unsubscribe`,
`isSubscribed`, `subscriptions`, `publish`, `cork`, `ping`, `close`,
`getBufferedAmount` are its own methods. `socket.data.path` is the gateway path;
`socket.data.context` is whatever `@OnUpgrade` returned.

### The upgrade is a route

`server.upgrade()` is called from inside a native route handler, so the gateway's
path is matched by Bun's router like any other path, and **no `fetch` handler is
needed** for a socket to connect. Consequences, all measured:

- A gateway path may be a **pattern**: `@Gateway('/room/:room')` works, and
  `@OnUpgrade()` is handed the `BunRequest`, so `req.params.room` is readable there
  and can be returned as the connection's `context`.
- A plain `GET` on a gateway path is **426**; any other method is Bun's native
  **404**, because the upgrade is mounted as a `GET`. A path no gateway and no
  controller serves is the same native 404 — there is nothing to fall through to.
- A path claimed by both a gateway and a controller route is a **boot error**
  naming both, since one of the two would otherwise be dropped from the table.
- `setGlobalPrefix()` moves routes, **not** gateways. A gateway path is the exact
  pathname a client dials.

### Discovery, and what is a boot error

Handlers are discovered at boot by walking each gateway instance's prototype chain,
so an abstract base gateway's handlers are inherited by every subclass and an
undecorated override still dispatches to the override. Nothing is read per message:
the handler table, the `websocket` object, and one upgrade closure per gateway are
built once.

These throw at boot rather than picking a winner:

- two handlers claiming one event or one lifecycle slot, named individually
- two gateways on one path, named individually
- a `@Gateway` class with no handlers at all
- a handler-declaring provider that is **not** a `@Gateway` — it could never
  receive a frame, so it is an error instead of a silent no-op

### The envelope

Named events need a way to say which event a frame is, so `@dunx/http` defines the
smallest one that works:

```json
{ "event": "chat.say", "data": { "room": "general", "text": "hi" } }
```

It is **opt-in**: a frame is only parsed for a gateway that declares at least one
`@OnMessage(event)` handler. A gateway with only a raw `@OnMessage()` never sees
JSON it did not ask for. Binary frames, invalid JSON, a non-object, a missing
`event`, and an event no handler claims all fall through to the raw handler — and
are ignored if there is none. Nothing is ever replied to the sender that a handler
did not return.

`encode(event, data)` and `decode(frame)` are exported, so a client can share them.
A handler's payload parameter type is what you expect to receive, not a runtime
guarantee: the frame's `data` is handed over as it arrived.

### Pub/sub

Topics live in Bun, not in a JavaScript map. A socket joins one with
`socket.subscribe(topic)` and leaves with `socket.unsubscribe(topic)`; both are
native methods on the socket you already hold.

`PubSub` is the injectable side, for publishing without a socket. `HttpFactory`
binds it around your root module, so nothing has to be imported or registered —
listing it in `providers` as well is the container's duplicate-binding error:

```ts
class Notifier {
  constructor(private readonly pubsub: PubSub) {}

  ship(version: string) {
    this.pubsub.publishEvent('releases', 'shipped', { version }); // envelope
    this.pubsub.publish('releases', 'raw frame'); // string or BufferSource
    return this.pubsub.subscriberCount('releases');
  }
}
```

`publish` returns the bytes sent, `0` if the message was dropped, `-1` under
backpressure — Bun's own status. It goes through `server.publish`, which reaches
**every** subscriber including the socket whose handler triggered it (unlike
`socket.publish`, which honours `publishToSelf`). Publishing before the server is
listening throws saying so.

### Socket options

```ts
await HttpFactory.create(AppModule, {
  websocket: {
    idleTimeout: 120, // seconds; Bun rejects anything above 960
    maxPayloadLength: 16 * 1024 * 1024,
    backpressureLimit: 1024 * 1024,
    closeOnBackpressureLimit: false,
    perMessageDeflate: true,
    publishToSelf: false,
    sendPings: true,
    onError: (error, socket) => console.error(socket.data.path, error),
  },
});
```

Everything but `onError` is Bun's `websocket` option of the same name, and the type
is `Pick`ed from Bun's own so the two cannot drift. They are server-wide, which is
why they sit beside `middleware` and `onError` on the factory rather than on a
module. `onError` catches a throwing or rejecting handler and the socket stays open;
the default logs.

### Shutdown with a live socket

Measured: a graceful `server.stop()` waits for open connections, and a WebSocket
does not close on its own — so it **never resolves** while a socket is open. An app
with at least one gateway therefore force-stops (`stop(true)`) in `shutdown()`, and
those clients see a `1006` close. An app with no gateways still stops gracefully.
Bun also delivers an empty close `reason` to `@OnClose` once a socket has exchanged
frames, whatever the client passed; the `code` is reliable.

## Status codes

`HttpStatusCode` is a frozen object, not an `enum` — one name serving as both the
value and the type, so it reads like an enum and erases like a constant:

```ts
import { HttpError, HttpStatusCode, type HttpStatusName } from '@dunx/http';

throw new HttpError(HttpStatusCode.NOT_FOUND, 'No such user');

const code: HttpStatusCode = HttpStatusCode.CONFLICT; // 200 | 201 | ... | 504
const name: HttpStatusName = 'CONFLICT'; // 'OK' | 'CREATED' | ...
```

`HttpError.status` stays `number`, so an uncommon code the table omits (451, 507)
still works.

## Notes

- Routes are discovered at boot by walking each controller's prototype chain, so an
  abstract base controller's `@Get` methods are inherited by every subclass.
- A duplicate method + path **throws at boot** naming both handlers. Bun would
  otherwise silently keep one.
- Middleware is a class with `handle(req, ctx, next)`, resolved from the container so
  it can `inject()`. Chains are folded into one closure per route at boot, and `ctx`
  is the route that closure belongs to.
- Handlers may return a `Response`, any JSON-serialisable value, or `undefined`
  for `204`.
- Schemas, parsers and the status are resolved in `buildRoutes` at boot, into the
  same closure the middleware chain folds into. Per request the framework parses
  and validates what was declared, calls the method, wraps the return, and maps a
  throw — no metadata read, no lookup, no DI.
- Gateways use the same marker-plus-prototype-scan discovery as routes, and go into
  the same route table. `withUpgradeRoutes` and `buildWebSocket` are exported for
  anyone assembling `Bun.serve` themselves.

## License

MIT
