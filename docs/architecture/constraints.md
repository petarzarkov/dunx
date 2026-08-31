# Verified constraints

What was measured on real Bun, and what each measurement rules out. Every other page here depends on this one.

## Why this exists

Elysia and Hono own Bun's web-framework space and are mature. Neither offers
dependency injection, modules, or class-based controllers. Elysia's chained
builder API is precisely what NestJS refugees bounce off, and that gap is the
whole product. dunx should stay a **DI + structure** framework that happens to
serve HTTP - not drift into a general web framework.

## Verified constraints

These were measured on Bun 1.3.14, not assumed. They drive most decisions below.

**Bun already has the router.** `Bun.serve({ routes })` handles path params,
per-method dispatch, static `Response` values, and 404-on-method-miss in native
Zig:

```
param route: 200 { id: "42" }   static route: 200 ok   unmatched method: 404
```

There is no reason to build a radix tree in JavaScript. dunx's job is to _emit_
the `routes` object at boot and hand it to Bun.

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
`Object.getOwnPropertyDescriptors` up the chain finds every marked method, and
`Object.entries(instance)` finds field-initialized route builders in the same
pass. Measured with **no class decorator anywhere**:

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
