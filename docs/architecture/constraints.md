# Verified constraints

What was measured on real Bun, and what each measurement rules out. Every other page here depends on this one.

## Why this exists

Elysia and Hono own Bun's web-framework space and are mature. Neither offers
dependency injection, modules, or class-based controllers. Elysia's chained
builder API is precisely what NestJS refugees bounce off, and that gap is the
whole product. dunx should stay a **DI + structure** framework that happens to
serve HTTP - not drift into a general web framework.

## Verified constraints

Measured, not assumed, on Bun 1.3.14 unless an entry names its own version.
They drive most decisions below.

**Bun already has the router.** `Bun.serve({ routes })` handles path params,
per-method dispatch, static `Response` values, and 404-on-method-miss in native
Zig:

```
param route: 200 { id: "42" }   static route: 200 ok   unmatched method: 404
```

There is no reason to build a radix tree in JavaScript. dunx's job is to _emit_
the `routes` object at boot and hand it to Bun.

**That router matches the literal path, so a trailing slash misses**, in both
directions: with `/users/:id` registered, `/users/1/` reaches the `fetch`
fallback, and a route declared `/dir/` is not served at `/dir`. Registering both
spellings is accepted. Bun 1.4.2:

```
/test  -> 200 R /test     /users/1  -> 200 R /users/:id id=1   /dir/ -> 200 R /dir/
/test/ -> 404 FALLBACK    /users/1/ -> 404 FALLBACK            /dir  -> 404 FALLBACK
/both  -> 200 R /both     /both/    -> 200 R /both/
```

`withTrailingSlashAliases` takes that last line: a second key holding the same
per-method object, so one set of handlers, one preflight, and one metrics
series, because `buildContext` froze the pattern into the closure. Every route
gets one except `/` and a wildcard mount, neither of which has a slashed
spelling to add. 500
routes bind in 1.8 ms plain and 3.3 ms aliased, with no per-request difference
above client overhead. It is opt-in: `strict` defaults to `true`, as hono's does.

The five frameworks, each on its own default:

| Framework                      | `/test/` | `/users/1/` | Option                     |
| ------------------------------ | -------- | ----------- | -------------------------- |
| express 5.2.1                  | 200      | 200         | `strict routing`, off      |
| nest 11.1.28 (express adapter) | 200      | 200         | none of its own            |
| elysia 1.4.29                  | 200      | 200         | `strictPath`, false        |
| fastify 5.11.0                 | 404      | 404         | `ignoreTrailingSlash`, off |
| hono 4.12.33                   | 404      | 404         | `strict`, true             |

None of the five redirects. express and hono strip the slash before lookup,
which takes being the router; elysia registers both spellings, which is the one
mechanism open to dunx, since Bun has matched before `fetch` is called.

**Bun resolves dot-segments for `req.url` but matches on the raw target.** Over
a raw socket, where nothing rewrites the request line:

```
GET /test      -> 200 MATCHED  seen=/test
GET /./test    -> 404 FALLBACK seen=/test
GET /a/../test -> 404 FALLBACK seen=/test
GET //test     -> 404 FALLBACK seen=//test
```

The matcher is the stricter of the two, so no request reaches a route whose
`pathname` disagrees with the path it matched. A probe using `fetch` sees
`//test` return 200 instead, because `fetch` collapses it before it is sent.

**`server.upgrade(req)` works from inside a `routes` handler.** Bun's own types
bless it: `Serve.RoutesWithUpgrade` allows `Response | undefined | void` when
`websocket` is present. So a WebSocket gateway is mounted as a native `GET`
route rather than needing a hand-written `fetch` fallback. That means **Bun's
router does run on the upgrade path**, and a gateway path may be a pattern
(`/room/:room`, with `req.params.room` readable in `@OnUpgrade`).

An earlier note claiming the opposite was wrong and is retired. With no `fetch`
handler anywhere, an unclaimed path is Bun's native 404 and a plain `GET` on a
gateway path is a 426.

**Graceful `server.stop()` never resolves while a WebSocket is open.** `stop(true)`
is required, and clients then observe close code 1006. An app with gateways must
therefore force-stop on shutdown or it hangs forever.

**`server.publish` reaches the sender; `socket.publish` does not** (absent
`publishToSelf`). The two are not interchangeable.

**A native method miss is a 404, so CORS preflight cannot be inferred.** With
`routes` and no `fetch` handler, `OPTIONS` against a GET-only route returns 404.
Add a `fetch` handler and it falls through to that instead:

```
OPTIONS, no fetch handler   -> 404
OPTIONS, with fetch handler -> 418 fell through
```

So `enableCors()` has to mount an explicit `OPTIONS` handler per path, built at
boot from the verbs that path actually declares. It cannot collide with a user
route, because `HttpMethod` has no `OPTIONS` verb.

**`server.requestIP(req)` is how the socket address is read**, and it returns an
object rather than a string:

```
server.requestIP(req) -> {"address":"::ffff:127.0.0.1","family":"IPv6","port":41458}
```

That is what `'trust proxy'` chooses between: the first `X-Forwarded-For` entry
when trusted, this address otherwise. `Response` headers are also mutable after
construction. This lets CORS headers be applied outside the error mapper, so a
mapped 500 still carries them.

**`emitDecoratorMetadata` is lossy.** With `experimentalDecorators` +
`emitDecoratorMetadata`, `constructor(db: Db, cache: Cache, n: number)` yields:

```
paramtypes: [ "Db", "Object", "Number" ]
```

An interface degrades to `Object`, a primitive to `Number`. Constructor
injection therefore _requires_ `@Inject(TOKEN)` for everything that isn't a
class - Nest's worst ergonomic wart, inherited on day one.

**Standard decorators + `inject()` work today, zero dependencies.** Route
metadata collection and a full singleton graph both run under TC39 decorators
with no polyfill and no `experimentalDecorators`.

**Member decorators are applied before the class decorator.** Source order within
a class, then the class itself - so a class decorator can drain what its own
members pushed:

```
member list   member one   class Users
```

**`ctx.metadata` is write-only in Bun, and leaks in both directions.** Bun 1.3.14
hands a `ctx.metadata` object to decorators but leaves `Symbol.metadata`
undefined. Nothing can read it back off the class without a polyfill - the exact
"must be the first import" fragility being escaped. Polyfilling it means each
class's metadata object gets its parent's as its **prototype**, so `routes ??= []`
in a subclass resolves through the chain and mutates the _parent's_ array:

```
Symbol.metadata: undefined        ctx.metadata in decorator: present
# after polyfill; Base(@Get list) <- Users(@Get one), Base <- Posts(no members)
Base[Symbol.metadata]  : { routes: [ "list", "one" ] }   # "one" belongs to Users
Posts[Symbol.metadata] : { routes: [ "list", "one" ] }   # Posts has neither method
```

`Object.hasOwn(Posts, Symbol.metadata)` is `true`, so ownership cannot filter it -
the class owns its metadata object; the array inside is shared.

**A global pending array drained by the class decorator loses and leaks routes.**
The ordering above makes the drain deterministic, but the array is not keyed by
class:

```
Base(@Get list) <- Users(@Get one), Base <- Posts(no members):
  Users -> [ "list", "one" ]     Posts -> []      # first subclass takes the base's
Orphan(@Get leaked, undecorated), then @Controller Unrelated(@Get mine):
  Unrelated -> [ "leaked", "mine" ]               # leaks, and across files
```

`name in Klass.prototype` separates the two exactly - `list` is in `Users`'s
chain, `leaked` is not in `Unrelated`'s - which turns both into boot errors.

**Overriding a decorated base method without re-decorating dispatches to the
override.** A closure over `instance[name]` resolves through the prototype chain
(measured: `override.impl`), so inherited routes need no re-declaration.

**Marking the method function and scanning the prototype chain needs no
accumulator and no class decorator.** A method decorator may set a symbol property
on the function it receives and return it. At boot, walking
`Object.getOwnPropertyDescriptors` up the chain finds every marked method. The
spike also scanned `Object.entries(instance)` for field-initialized route builders
(the `field create` row below); dunx ships only the prototype walk. Measured with
**no class decorator anywhere**:

```
Users:  GET /:id <- proto Users.one   GET / <- proto BaseCrud.list   POST / <- field create
Posts:  GET / <- proto BaseCrud.list
Ov:     GET / <- proto BaseCrud.list        # own undecorated override does not shadow
Orphan: GET /leaked <- proto Orphan.leaked  # found, but in no other class's chain
```

Two subclasses of one undecorated abstract base both resolve the base's route. A
field handler's arrow captures `this` (`users.one`). A field declared before the
field it reads still works too, because handlers run per request (`late-value`).

**A route decorator can _check_ a handler's input type but cannot _infer_ it.**
Measured with `tsc`, because this is a type-level claim `bun` cannot answer. Given
`@Post(path, opts)` generic over the options and constraining the method it
decorates:

```
annotated correctly            -> compiles
unannotated parameter          -> TS7006: Parameter 'input' implicitly has an 'any' type
annotated with the wrong type  -> TS1241 + TS1270, naming the mismatched property
```

A standard method decorator is `(value: V, ctx: ClassMethodDecoratorContext) => V | void`.
It can reject a mismatched `V` but has no way to contextually type an unannotated
parameter, so input must be annotated. The annotation is a type-level function
over the options object, so each type is still written once:

```ts
const createNote = { body: CreateNote, status: HttpStatusCode.CREATED } as const;

@Post('/', createNote)
create(input: Input<typeof createNote>): Note {
  return this.notes.add(input.body.text);   // input.body.text is string
}
```

Verified that the wrong return type on that exact shape fails with
`Type 'string' is not assignable to type 'number'`.

**The same decorator can check the _return_ type against `options.response`.**
Measured with `tsc` under the root's flags, on a `Returns<O, M>` constraint keyed
to the route's success status:

```
matches the declared success schema        -> compiles
a promise of it                            -> compiles
a wider object                             -> compiles
readonly T[] against a schema inferring T[] -> compiles
Response, or a promise of one               -> compiles
missing a required property                -> TS1241 + TS1270, naming it
the declared 404 shape on the success path  -> TS1241 + TS1270
null or undefined against a declared body   -> TS1241 + TS1270
```

Four results worth keeping:

- **Keying on the success status rather than the union of every declared status is
  what catches the realistic mistake.** A route declaring
  `{ 200: User, 404: Problem }` and returning the `Problem` shape on the success
  path answers 200 with an error body; against a union of both it compiles.
  `DefaultStatus<M>` in `route/marker.ts` is what makes that reachable at the type
  level, which is why the verb factory takes `<const M extends HttpMethod>` - a
  widened `HttpMethod` cannot tell a POST's 201 from a GET's 200.
- **`readonly T[]` had to be admitted.** `z.array()` infers a mutable `T[]`, and
  `readonly T[]` is not assignable to it, so a repository returning
  `readonly User[]` failed against a document it satisfies. `Serialised<T>` rewrites
  every array in the declared shape to `readonly`, which the mutable one still
  satisfies. Only arrays need it: TypeScript already ignores a property's `readonly`
  modifier when checking assignability, so the object branch exists to reach nested
  arrays. A function is returned untouched, because mapping over one discards its
  call signature.
- **`infer R extends ResponseMap` is load-bearing.** Without the constraint the
  narrowed `O` in the branch is `{ response: R } & O`, whose `response` no longer
  satisfies `RouteSchemas`, and the nested `SuccessStatus<O, M>` fails with
  `TS2344`. Measured both ways.
- **A plain `JsonSchema` entry turns the check off for that route**, becoming
  `unknown`, which absorbs any return type. There is no type to infer from JSON, so
  this is the escape hatch for a response no schema value describes. Options
  widened by a missing `as const` do the same thing.

It found a real defect on the first run: `examples/full` documented `User` with a
`tags: string[]` the `users` table has no column for, so every user response
advertised an array no handler returned.

**Deriving the response schema from the return type is the direction that stays
closed.** `@dunx/transform` is `oxc-parser`: a single-file syntax parser with no
program and no checker. It reads a return type's syntax fine, but
`Promise<UserDto>` is a name that needs cross-file resolution, generics and mapped
types to become a schema. That requires a type checker, the same kind
`@nestjs/swagger`'s plugin runs during `nest build`.

A class return type gives a runtime value whose field annotations are erased, and
the two things Nest leans on for that (`emitDecoratorMetadata`, parameter
decorators) are both banned here.

Probed: the one extractable case is a return type whose syntax names a runtime
value, as `z.infer<typeof User>` does, where `TSTypeQuery.exprName` is the schema.
It was rejected anyway. `Promise<z.infer<typeof User>[]>` silently yields `User`,
losing the array. Fixing that means implementing `[]`, `Array<>`, `Partial<>` and
`Pick<>` as operations over a runtime schema value. It also only helps someone who
already holds the schema value they could have written into `response`.

**`drizzle-orm/bun-sql` is Postgres, not `Bun.SQL`.** `Bun.SQL` speaks four
dialects - `postgres`, `mysql`, `mariadb`, `sqlite`, quoted from its own rejection
message. Its drizzle adapter speaks one. Read from `bun-sql/driver.js` in
drizzle-orm 0.45.2:

```js
const dialect = new PgDialect({ casing: config.casing });
```

Unconditional, with no branch on `client.options.adapter` anywhere in the module.
Pointed at a `sqlite://` client it does not error. It compiles `$1` placeholders
and Postgres identifier quoting against SQLite, and the trivial cases pass, which
is worse than failing.

Two consequences. `SqlOptions` rejects a non-Postgres URL at construction rather
than at connect time; and **MySQL/MariaDB have no drizzle path on Bun at all**,
since drizzle's own MySQL adapters need `mysql2`, a client Bun already replaces.
This also retired a trick the `@dunx/infra` test suite used to rely on - running
the `Bun.SQL` suite over that driver's SQLite adapter so the whole code path was
covered with no server installed. A green suite compiling Postgres SQL against
SQLite proves nothing, so the wire-protocol tests skip unless `DUNX_DB_TEST_URL`
names a reachable server.

**drizzle's `transaction()` on bun-sqlite inherits `bun:sqlite`'s
synchronous-commit behaviour.** `bun:sqlite`'s own `db.transaction()` commits when
its callback **returns its promise**, so awaited work is already committed and a
later throw rolls back nothing (recorded in [bun-apis.md](../bun-apis.md)). drizzle
does not work around it - `bun-sqlite/session.js` delegates straight to it:

```js
const nativeTx = this.client.transaction(() => {
  result = transaction(tx);
});
nativeTx[config.behavior ?? 'deferred']();
```

Measured on Bun 1.3.14: insert, `await Bun.sleep(1)`, throw, catch - the row is
still there. So `drizzle` being a mature library does not make this one safe.
`@dunx/infra/db` exports a standalone `transaction(db, fn)` that issues
`BEGIN`/`COMMIT`/`ROLLBACK` itself. There is one connection, so overlapping
top-level transactions queue rather than nest a second `BEGIN`; a nested call
is already inside the holder's turn and takes a savepoint instead.

On Postgres the same function delegates to drizzle's own `transaction()`, which
is genuinely async because `Bun.SQL`'s `begin()` reserves a connection for the
duration.

**A decorator cannot publish a type back onto the class it decorates.** Measured on
TypeScript 7.0.2 - both routes fail with `TS2339: Property 'table' does not exist`:

```
@Entity('users') class UserA {}   UserA.table   // decorator defineProperty'd a static
@Entity('users') class UserB {}   UserB.table   // decorator's return type is C & { table }
```

TC39 decorators are **type-transparent** in TypeScript: the decorator's return type
does not become the declaration's type. So a decorator can attach a runtime value but
cannot tell the type system it is there.

This is why **entity decorators were rejected**. drizzle's whole value is the table
object's _type_ carrying column types into every query; a decorator could build a
working table at runtime while every query degraded to `unknown`. Recovering the
types would mean hand-writing a mapped type mirroring drizzle's `BuildColumns`: a
second source of truth that drifts from the first, undoing the duplication
decorators were meant to remove. drizzle's native `sqliteTable` object schema is the
supported path.

The same limit explains why `@Post('/', opts)` can _check_ a handler's input
annotation but not _infer_ it. Decorators observe; they do not type. Note the
contrast with `@Controller`, `@Get`, `@Module`, `@Gateway` and `@Roles`, which all
work fine - they only _record_ metadata read back at boot, and publish nothing to
the type system.

The constraints above cover the request path and dependency injection. The one
below covers testing the dashboard itself.

## `Bun.WebView` drives the dashboard headlessly, on Bun 1.4.0

**The claim: a real browser can assert what happy-dom cannot** - that
`@dunx/dashboard`'s inlined bundle executes, and that the CSS list in
`internal/dashboard-ui/src/styles.ts` is complete enough for the page to paint.
`internal/dashboard-ui`'s suite renders components through happy-dom, which has no
layout and no cascade, so a missing stylesheet passes it.

Probed against the real `examples/full` app, its dashboard mounted at
`/api/_dunx`, with the display unset so the run matches a CI runner:

```
env -u DISPLAY bun --preload @dunx/transform/preload probe.ts

{"nodes":227,"styleTags":8,"bodyBg":"rgb(36, 36, 36)",
 "bodyFont":"-apple-system, BlinkMacSystemF","mantineVars":"#242424",
 "text":"dunx DUNX-FULL up 307ms live 5s Overview Routes Gateways Modules &
 providers Queues & Redis Configuration bull-board Jobs, flows and metrics
 API explorer What a","errors":[]}
title: "dunx-full dashboard"
screenshot bytes: 67832
```

What each number rules out. 227 nodes means the inlined bundle ran, since the
served shell is a handful of elements. 8 `<style>` tags and a computed
`background-color` of `rgb(36, 36, 36)` matching `--mantine-color-body: #242424`
mean the cascade resolved: happy-dom cannot make that assertion at all. The panel
text and a 67 KB screenshot cover the render.

Three things to consider before building on it:

- **No display is needed and none is used.** The same probe produces a
  byte-identical 3,510-byte screenshot of a trivial page with `DISPLAY=:0` and with
  it unset, so the windowed path is not being taken.
- **It drives an installed Chrome on Linux**, found at `/usr/bin/google-chrome`.
  There is nothing to `bun add`, and no browser download step, but the runner has
  to have one. macOS uses the system WebKit instead.
- **`navigate()` resolves before React has rendered.** The probe polls
  `document.querySelectorAll('*').length` until it passes 50 rather than sleeping
  for a fixed interval.

The surface is `navigate`, `evaluate`, `screenshot`, `cdp`, `click`, `type`,
`press`, `scroll`, `scrollTo`, `resize`, `goBack`, `goForward`, `reload`, `close`,
`url`, `title`, `loading`, `onNavigated`, `onNavigationFailed`.

**Playwright was not measured, because this answered the question first.** It is
permitted here - `internal/*` is exempt from Rule 1 - and would be the fallback if
a test needed more than the list above. `Bun.WebView` costs no dependency and no
browser download. That makes it what a dashboard smoke test should be written
against.

## OpenTelemetry spans, on Bun 1.4.2

Probed for issue #82 with `@opentelemetry/api` 1.9.1 and `@opentelemetry/sdk-trace-node`
2.11.0. Four claims, four probes.

**A static import of an absent optional peer fails the whole entry.** A package
module importing `@opentelemetry/api` at its top, installed from a packed tarball
with the peer missing:

```
error: Cannot find module '@opentelemetry/api' from '.../node_modules/fakepkg/static.js'
```

The same import behind its own subpath export leaves the root entry loading
(`main ok`), and `bun build --compile` bundles the subpath when the peer is present.
So the OTel code lives in `@dunx/core/otel`, the pattern `@dunx/infra/db` already
follows. A probe that installs the fake package from a `file:` directory instead
passes wrongly: the symlinked files have no `node_modules` and Bun auto-installs
the peer.

**Two copies of the API share one global in one direction only.**

| Provider registered via | Span started via | Exported |
| ----------------------- | ---------------- | -------- |
| 1.9.0                   | 1.8.0            | yes      |
| 1.8.0                   | 1.9.0            | no       |

`setGlobalTracerProvider` returned `true` in both rows. A dunx that depended on a
newer API than the app's SDK would drop every span without an error, so the API is
a peer with a low floor.

**dunx's request scope and the OTel context coexist.** Two `AsyncLocalStorage`
stores side by side, dunx's `RequestContext` and the SDK's context manager, with
the handler run inside `context.with(trace.setSpan(...))`. A user span parented to
the server span at every checkpoint:

```
sync/await/timeout/sqlite/Bun.SQL  otelParent=4e4fb8fa38067db4 dunxSpan=4e4fb8fa38067db4
exported server: trace=aaaaaaaa parent=bbbbbbbbbbbbbbbb remote=true
```

Log lines only join spans when dunx writes the recording span's ids into its own
scope; minting its own span id beside the SDK's never matches. Reading ids from
`trace.getActiveSpan()` instead was rejected: with no SDK registered it returns
none, and logs lose `traceId` entirely.

**A span is cheap until an SDK records it.** `oha -c 64`, plaintext, five
interleaved rounds per configuration, two runs, as a share of the same run's
baseline:

| Configuration                                     | Share of baseline | Added per request |
| ------------------------------------------------- | ----------------- | ----------------- |
| A new global async middleware, no OTel            | 85.5%             | 1.26 us           |
| That, plus a span with no provider                | 81.2%             | 0.45 us more      |
| Span, SDK with `BatchSpanProcessor`, no-op export | 69.0-70.3%        | 2.0 us more       |
| Span, SDK with an in-memory exporter              | 62.1-63.8%        | 3.2 us more       |

In a tight loop with no provider, `startSpan` costs 11 ns and `startActiveSpan`
115 ns. Two decisions follow: spans are opt-in through `OtelModule`, and the
default `Tracer` never calls the API. The server span opens inside the existing
request-logging middleware rather than a new one, since the middleware seam alone
costs more than the span.

**Trace context reaches a forked bullmq worker without touching `job.data`.**
bullmq 6.3.4 stores `opts.telemetry.metadata` in Redis and hands `job.opts` to the
`isolation: 'process'` child. Over `createBunRedisClient` against a real Redis:

```
CHILD {"data":{"to":"a@b"},"telemetry":{"metadata":"00-4c25f2...-e0d0acf3020be687-01"}}
```

AMQP already carries `traceparent` in message headers; `src/amqp/live.test.ts`
passes against `rabbitmq:4-alpine`.

## Security response headers, on Bun 1.4.2

Probed before `securityHeaders` was built. Four claims.

**`Bun.serve` adds no security header, and no `Server` or `X-Powered-By`.** A
static `Response` route, a handler route and a miss, read back with `fetch`:

```
/static 200 [["content-length","2"],["content-type","text/plain;charset=utf-8"],["date","..."],["etag","\"ea8842e9ea2638fa\""]]
/handler 200 [["content-length","2"],["content-type","text/plain;charset=utf-8"],["date","..."]]
/missing 404 [["content-length","0"],["date","..."]]
```

Every `Response` kind tried has mutable headers, so a wrapper can `set` in place
rather than rebuild: `Response.redirect`, `Response.error`, `Response.json`, a
`fetch()` result and a `Bun.file` body all printed `mutable`.

**better-auth sets none either.** Against `examples/full`, `GET /api/auth/ok`,
`GET /api/auth/get-session`, `POST /api/auth/sign-up/email` and a failed
`POST /api/auth/sign-in/email` carried `content-type`, `ratelimit-*`,
`traceresponse`, `cache-control`/`pragma` on the session route and `set-cookie`
on sign-up. None carried `x-content-type-options`, `x-frame-options`, a CSP,
`referrer-policy`, `strict-transport-security` or any `cross-origin-*`.

**Every page dunx serves breaks under a strict CSP, and hashes fix all of
them.** The strict policy was
`default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'`,
added by a proxy in front of `examples/full` and read back through `Bun.WebView`
with a `securitypolicyviolation` listener installed by
`Page.addScriptToEvaluateOnNewDocument`:

| Page                      | No CSP     | Strict CSP                                                                                               | Needs                                               |
| ------------------------- | ---------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `/api/docs` (Swagger)     | 3249 nodes | blank, 14 nodes: `script-src-elem inline`, `style-src-elem inline`                                       | boot script hash; inline `<style>`                  |
| `/api/reference` (Scalar) | 1810 nodes | blank, 16 nodes: `script-src-elem inline`, 5x `style-src-elem inline`, `img-src data`, `script-src eval` | boot script hash; runtime `<style>`; `data:` images |
| `/api/dashboard`          | 268 nodes  | blank, 14 nodes: `script-src-elem inline`, `style-src-elem inline`, `img-src data`                       | bundle hash; 18 runtime `<style>` injections        |
| `/api/dashboard/queues`   | 133 nodes  | 133 nodes, unstyled: `style-src-attr inline`, Google Fonts, `img-src data`                               | open styles and fonts                               |
| `/api/email/preview`      | 20 nodes   | 20 nodes, preheader shown: 9x `style-src-attr inline`                                                    | inline styles                                       |
| `/` (landing)             | 294 nodes  | 314 nodes: `img-src data`                                                                                | `data:` images                                      |

No page needed `'unsafe-inline'` for scripts. Each inline boot script is fixed per
boot, so its hash is computed once: the dashboard's 444 KB bundle is a module
constant, and two requests for the Swagger page gave identical script text.
Scalar's one `eval` report is zod's `Function('')` feature probe, which falls
back; Scalar also calls `api.scalar.com`, which a `connect-src 'self'` refuses.
The email preview CLI (`bunx dunx-email preview`) is its own `Bun.serve` and
never sees the app's headers.

Hence the design: CSP is opt-in, and each framework page sends
`script-src 'self' 'sha256-...'; object-src 'none'; base-uri 'self'`, which the
app's wrapper keeps because it only sets a header the response lacks. Styles,
images, fonts and connections are left unrestricted on those pages.

Re-run against the shipped code with no proxy, `examples/full` sending
`STRICT_CSP` plus `img-src 'self' data:` app-wide:

```
/                      284 nodes  violations []
/api/docs             3249 nodes  violations []
/api/reference        1810 nodes  violations ["script-src eval @standalone.js:464"]
/api/dashboard         268 nodes  violations []
/api/dashboard/queues  133 nodes  violations []
/api/email/preview      20 nodes  violations []
```

The one report is the zod probe above. Twenty panels on `/` clicked through,
the chat websocket, the SSE feed and the RPC call among them, raised none.

**Seven headers cost about 1.1 us a request, set in place.** `oha -c 64`,
plaintext, five interleaved rounds per configuration, two runs, median as a
share of the same run's baseline:

| Configuration                                             | Run 1 | Run 2 | Added per request |
| --------------------------------------------------------- | ----- | ----- | ----------------- |
| `async` wrapper, `headers.set` x7                         | 83.8% | 85.8% | 1.25-1.44 us      |
| Sync-aware wrapper, `headers.set` x7                      | 87.3% | 87.5% | 1.08 us           |
| Sync-aware wrapper, `set` only where `has` is false       | 84.1% | 85.5% | 1.28-1.41 us      |
| Rebuilt `Response` with a precomputed `Headers` merged in | 79.3% | 84.1% | 1.43-1.95 us      |

The rebuilt `Response` also lost the implicit `content-type`, answering
`application/octet-stream` for a string body. The sync-aware set-if-absent row
shipped: `has` costs about 0.2-0.3 us over a blind `set`, and it is what lets a
page or a route keep its own header. With `securityHeaders` off the wrapper is
not installed.

## Idempotency keys, on Bun 1.4.2

Probed before `@Idempotent()` was built, against valkey 8 on loopback. Three
claims.

**`SET key value NX PX ms` is an atomic claim through either client.**
`Bun.RedisClient.set(k, v, 'NX', 'PX', '5000')` and `send('SET', [k, v, 'NX',
'PX', '5000'])` both answer `"OK"` to the first call and `null` to the second.
Thirty-two clients claiming one key at once, five rounds:

```
round 0: 32 concurrent claims, winners=1 nulls=31 stored=owner-0
round 4: 32 concurrent claims, winners=1 nulls=31 stored=owner-31
compare-and-del wrong token: 0 right token: 1
```

`RedisIdempotencyStore` sends through `send`, because `RedisConnection.set` takes
an options object where `Bun.RedisClient.set` takes variadic strings, and
completes or releases with one compare-and-swap `EVAL`, so a request whose lease
expired cannot overwrite the retry that took its key.

**Buffering a handler's `Response` leaves the one returned intact.** A 249-byte
`Response.json` with a `location` header, in a loop and through `Bun.serve`:

| Strategy                        | us/op | Served body intact |
| ------------------------------- | ----- | ------------------ |
| `Response.json` alone           | 0.62  |                    |
| `clone()` then `clone.bytes()`  | 1.04  | yes                |
| `bytes()` then a new `Response` | 1.16  | yes                |
| `clone()`, `for await` its body | 11.80 |                    |
| `clone()`, `blob()`, `bytes()`  | 1.57  |                    |

The clone path keeps the original unread, so middleware outside the guard still
sets headers on it. `blob()` over a 200 MB `Bun.file` body took 0.04 ms and
0.8 MB of RSS and reported the size, so the cap is checked without reading the
file. No `Response` kind tried carries `content-length` before it is sent.

**An opted-in route costs 8 to 21 us a request; one without costs nothing.**
`oha -c 64`, a JSON body schema route, five interleaved rounds per
configuration, two runs, median as a share of the same server's undecorated
route. "New key" varies the subject per request so every request claims;
"replay" repeats one key.

| Configuration                     | Run 1 | Run 2 | Added per request |
| --------------------------------- | ----- | ----- | ----------------- |
| Memory store, new key             | 44.3% | 43.3% | 16.1-16.6 us      |
| Memory store, replay              | 61.7% | 61.0% | 7.9-8.1 us        |
| Redis store, new key              | 36.0% | 37.3% | 20.8-21.2 us      |
| Redis store, replay               | 42.1% | 42.7% | 16.4-16.6 us      |
| Undecorated route, app without it | 99.1% | 96.7% | none              |

The last row compares the Redis server's undecorated route with an app that
never imports `IdempotencyModule`. The memory server's undecorated route ran
5-8% below that app, because its heap held every key the new-key rounds stored.
The new-key cost, built up one step at a time in a probe guard: draining the body
and reparsing it 2.2-3 us, SHA-256 1.6-2 us, the claim 3-4 us, cloning and
reading the response 2-3.5 us. The first build read the clone with `for await`
and cost 31 us; `blob()` replaced it.

## CSRF protection, on Bun 1.4.2

Probed before `csrf` was built. The design is Go 1.25's
`net/http.CrossOriginProtection` (`src/net/http/csrf.go` at `go1.25.0`, and
Filippo Valsorda's "Cross-Site Request Forgery", 13 Aug 2025): safe methods
pass, `Sec-Fetch-Site` decides when present, `Origin` against `Host` when not,
and a request with neither is not from a browser. Hono 4.13.9's `csrf` checks
only form content types (`application/x-www-form-urlencoded`,
`multipart/form-data`, `text/plain`), so a cross-site `fetch` with a JSON body
the browser sends through CORS is not refused there. Four claims.

**better-auth already refuses a cross-site write to its own routes.**
better-auth 1.6.25 with `baseURL` set, served as `AuthHandler` serves it (the
`Response` of `auth.handler(req)`, untouched), a session cookie on every call:

```
no Origin, no Sec-Fetch-Site (curl)                 sign-in 403 MISSING_OR_NULL_ORIGIN | sign-out 403 MISSING_OR_NULL_ORIGIN
Origin evil.test + Sec-Fetch-Site cross-site        sign-in 403 INVALID_ORIGIN         | sign-out 403 INVALID_ORIGIN
Origin evil.test only                               sign-in 403 INVALID_ORIGIN         | sign-out 403 INVALID_ORIGIN
Sec-Fetch-Site cross-site only, no Origin           sign-in 403 MISSING_OR_NULL_ORIGIN | sign-out 403 MISSING_OR_NULL_ORIGIN
same-origin                                         sign-in 200                        | sign-out 200
```

It is stricter than Go's rule: a cookie with no `Origin` is refused. So `csrf`
covers the auth routes rather than skipping them, since everything it refuses
there better-auth would refuse too, and skipping them needs a per-route opt-out
nothing else wants. The one conflict is an origin trusted by one and not the
other, which the guide states. Under `NODE_ENV=test` better-auth skips its
check (see authentication.md), so `examples/full`'s in-process suites see only
dunx's.

**Bun passes the headers through as sent, and builds `req.url` from `Host`.**
A raw HTTP/1.1 request over `Bun.connect` to a `routes` handler:

```
> Host: app.internal:8080 / Origin: https://Shop.Example / Sec-Fetch-Site: Cross-Site
> X-Forwarded-Host: shop.example, evil.test / X-Forwarded-Proto: https
{"url":"http://app.internal:8080/x","host":"app.internal:8080","origin":"https://Shop.Example",
 "sfs":"Cross-Site","xfh":"shop.example, evil.test","xfp":"https"}
> (no Host)
HTTP/1.1 400 Bad Request
```

Case survives, so the comparison is exact, as Go's is: an unknown
`Sec-Fetch-Site` value is refused. `X-Forwarded-Host` never reaches `req.url`.
Behind a proxy that rewrites `Host`, the `Origin` fallback compares against
`X-Forwarded-Host` only when `trust proxy` is set, counted from the right by the
same hop count `ClientAddress` uses for `X-Forwarded-For`. A modern browser
behind a TLS proxy sends `Sec-Fetch-Site` and never reaches the fallback.

**Chrome's values are the ones the rule expects.** Chrome 154.0.8037.57
through `Bun.WebView`, a target on `127.0.0.1`, a form on `localhost` posting
to it, and a page on another `127.0.0.1` port calling it:

```
navigate to target (typed)         GET  sfs=none mode=navigate origin=null
same-origin fetch POST             POST sfs=same-origin mode=cors origin=http://127.0.0.1:40913
cross-site form POST               POST sfs=cross-site mode=navigate origin=http://localhost:39015
same-site (other port) fetch POST  POST sfs=same-site mode=cors origin=http://127.0.0.1:41485
```

`same-site` is a different origin on the same registrable domain, and is
refused as Go refuses it.

**The check costs 0.5 to 0.9 us on an unsafe request.** `oha -c 64`, a `POST`
route answering `ok`, five interleaved rounds per configuration, two runs,
median as a share of the same run's unwrapped route. The wrapper is sync, built
at boot like the security headers, and installed on unsafe-method entries only:

| Configuration                       | Run 1 | Run 2 | Added per request |
| ----------------------------------- | ----- | ----- | ----------------- |
| `Sec-Fetch-Site: same-origin`       | 91.2% | 91.6% | 0.70-0.71 us      |
| `Origin` fallback, host equals Host | 91.7% | 89.6% | 0.67-0.88 us      |
| Neither header (a non-browser)      | 91.1% | 94.1% | 0.48-0.72 us      |

Below the 1.26 us of a new global async middleware, and a `GET` pays nothing.
A refusal is answered outside the chain and ahead of any rate limit, so it
writes its own `warn` line through the bound `Logger`, at most one a second,
the next carrying a `suppressed` count. One window for every refusal rather
than one per origin: a non-browser attacker chooses its `Origin`, so a window
per origin would let it rotate past the limit. Request logging's own `warn` for
every 4xx is not throttled, so a flood of 404s still writes a line each.
