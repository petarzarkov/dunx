# dunx — Architecture

A Bun-native DI framework with NestJS-shaped ergonomics and none of the Nest
runtime. Standard (TC39) decorators, no `reflect-metadata`, no `tsyringe`, no
per-request container work.

## Why this exists

Elysia and Hono own Bun's web-framework space and are mature. Neither offers
dependency injection, modules, or class-based controllers, and Elysia's chained
builder API is precisely what NestJS refugees bounce off. That gap is the whole
product. dunx should stay a **DI + structure** framework that happens to serve
HTTP — not drift into a general web framework.

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
bless it — `Serve.RoutesWithUpgrade` allows `Response | undefined | void` when
`websocket` is present. So a WebSocket gateway is mounted as a native `GET` route
rather than needing a hand-written `fetch` fallback, which means **Bun's router does
run on the upgrade path** and a gateway path may be a pattern (`/room/:room`, with
`req.params.room` readable in `@OnUpgrade`). An earlier note claiming the opposite
was wrong and is retired. With no `fetch` handler anywhere, an unclaimed path is
Bun's native 404 and a plain `GET` on a gateway path is a 426.

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
construction, which is what lets CORS headers be applied outside the error mapper
so a mapped 500 still carries them.

**`emitDecoratorMetadata` is lossy.** With `experimentalDecorators` +
`emitDecoratorMetadata`, `constructor(db: Db, cache: Cache, n: number)` yields:

```
paramtypes: [ "Db", "Object", "Number" ]
```

An interface degrades to `Object`, a primitive to `Number`. Constructor
injection therefore _requires_ `@Inject(TOKEN)` for everything that isn't a
class — Nest's worst ergonomic wart, inherited on day one.

**Standard decorators + `inject()` work today, zero dependencies.** Route
metadata collection and a full singleton graph both run under TC39 decorators
with no polyfill and no `experimentalDecorators`.

**Member decorators are applied before the class decorator.** Source order within
a class, then the class itself — so a class decorator can drain what its own
members pushed:

```
member list   member one   class Users
```

**`ctx.metadata` is write-only in Bun, and leaks in both directions.** Bun 1.3.14
hands a `ctx.metadata` object to decorators but leaves `Symbol.metadata`
undefined, so nothing can read it back off the class without a polyfill — the
exact "must be the first import" fragility being escaped. Polyfill it and each
class's metadata object gets its parent's as its **prototype**, so `routes ??= []`
in a subclass resolves through the chain and mutates the _parent's_ array:

```
Symbol.metadata: undefined        ctx.metadata in decorator: present
# after polyfill; Base(@Get list) <- Users(@Get one), Base <- Posts(no members)
Base[Symbol.metadata]  : { routes: [ "list", "one" ] }   # "one" belongs to Users
Posts[Symbol.metadata] : { routes: [ "list", "one" ] }   # Posts has neither method
```

`Object.hasOwn(Posts, Symbol.metadata)` is `true`, so ownership cannot filter it —
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

`name in Klass.prototype` separates the two exactly — `list` is in `Users`'s
chain, `leaked` is not in `Unrelated`'s — which turns both into boot errors.

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
field handler's arrow captures `this` (`users.one`), and a field declared before
the field it reads still works, because handlers run per request (`late-value`).

**A route decorator can _check_ a handler's input type but cannot _infer_ it.**
Measured with `tsc`, because this is a type-level claim `bun` cannot answer. Given
`@Post(path, opts)` generic over the options and constraining the method it
decorates:

```
annotated correctly            -> compiles
unannotated parameter          -> TS7006: Parameter 'input' implicitly has an 'any' type
annotated with the wrong type  -> TS1241 + TS1270, naming the mismatched property
```

A standard method decorator is `(value: V, ctx: ClassMethodDecoratorContext) => V | void`,
so it can reject a mismatched `V` but has no way to contextually type an
unannotated parameter. Input must therefore be annotated — and the annotation is a
type-level function over the options object, so each type is still written once:

```ts
const createNote = { body: CreateNote, status: HttpStatusCode.CREATED } as const;

@Post('/', createNote)
create(input: Input<typeof createNote>): Note {
  return this.notes.add(input.body.text);   // input.body.text is string
}
```

Verified that the wrong return type on that exact shape fails with
`Type 'string' is not assignable to type 'number'`.

**`drizzle-orm/bun-sql` is Postgres, not `Bun.SQL`.** `Bun.SQL` speaks four
dialects — `postgres`, `mysql`, `mariadb`, `sqlite`, quoted from its own rejection
message. Its drizzle adapter speaks one. Read from `bun-sql/driver.js` in
drizzle-orm 0.45.2:

```js
const dialect = new PgDialect({ casing: config.casing });
```

Unconditional, with no branch on `client.options.adapter` anywhere in the module.
Pointed at a `sqlite://` client it does not error — it compiles `$1` placeholders
and Postgres identifier quoting against SQLite, and the trivial cases pass, which
is worse than failing.

Two consequences. `SqlOptions` rejects a non-Postgres URL at construction rather
than at connect time; and **MySQL/MariaDB have no drizzle path on Bun at all**,
since drizzle's own MySQL adapters need `mysql2`, a client Bun already replaces.
This also retired a trick the `@dunx/infra` test suite used to rely on — running
the `Bun.SQL` suite over that driver's SQLite adapter so the whole code path was
covered with no server installed. A green suite compiling Postgres SQL against
SQLite proves nothing, so the wire-protocol tests skip unless `DUNX_DB_TEST_URL`
names a reachable server.

**drizzle's `transaction()` on bun-sqlite inherits `bun:sqlite`'s
synchronous-commit behaviour.** `bun:sqlite`'s own `db.transaction()` commits when
its callback **returns its promise**, so awaited work is already committed and a
later throw rolls back nothing (recorded in [bun-apis.md](./bun-apis.md)). drizzle
does not work around it — `bun-sqlite/session.js` delegates straight to it:

```js
const nativeTx = this.client.transaction(() => {
  result = transaction(tx);
});
nativeTx[config.behavior ?? 'deferred']();
```

Measured on Bun 1.3.14: insert, `await Bun.sleep(1)`, throw, catch — the row is
still there. So `drizzle` being a mature library does not make this one safe, and
`@dunx/infra/db` exports a standalone `transaction(db, fn)` that issues
`BEGIN`/`COMMIT`/`ROLLBACK` itself. There is one connection, so overlapping
top-level transactions queue rather than nest a second `BEGIN`; a nested call is
already inside the holder's turn and takes a savepoint instead. On Postgres the
same function delegates to drizzle's own `transaction()`, which is genuinely async
because `Bun.SQL`'s `begin()` reserves a connection for the duration.

**A decorator cannot publish a type back onto the class it decorates.** Measured on
TypeScript 7.0.2 — both routes fail with `TS2339: Property 'table' does not exist`:

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
types would mean hand-writing a mapped type mirroring drizzle's `BuildColumns` — a
second source of truth that drifts from the first, which is exactly the duplication
decorators were meant to remove. drizzle's native `sqliteTable` object schema is the
supported path.

The same limit explains why `@Post('/', opts)` can _check_ a handler's input
annotation but not _infer_ it. Decorators observe; they do not type. Note the
contrast with `@Controller`, `@Get`, `@Module`, `@Gateway` and `@Roles`, which all
work fine — they only _record_ metadata read back at boot, and publish nothing to
the type system.

## The decorator dialect decision

`tsyringe` and `@Inject()`-style constructor injection are locked to legacy
`experimentalDecorators` **permanently**: TC39 standard decorators have no
parameter decorators, so `constructor(@inject(X) x: X)` has no migration path.
Building a new framework on the dialect TypeScript is walking away from, in
order to buy a lossy metadata table you then work around, is a bad trade.

dunx uses **standard decorators only**. The root `tsconfig.json` must not set
`experimentalDecorators` or `emitDecoratorMetadata`.

That rules out the _decorator_ route to constructor injection. It does not rule
out constructor injection — see below.

## Constructor injection without decorator metadata

An earlier draft of this document concluded that constructor injection was
unavailable and that `inject()` in field initializers was the only option. That
conclusion was wrong: it assumed the parameter types had to be recovered at
runtime, which is the only thing decorators could have done. They can be read at
**load time** instead, from the source that still has them.

`@dunx/compiler` is a Bun plugin. On load it parses each file with `oxc-parser`,
reads every class's constructor parameter types, and appends one statement per
class:

```ts
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}
}
Object.defineProperty(UsersService, Symbol.for('dunx.deps'), {
  value: () => [UsersRepository],
});
```

The container reads that record and resolves the arguments before calling `new`.
So the user-facing syntax carries **no annotation at all** — no `@Injectable`, no
`@Inject`, no `inject()`, no `reflect-metadata`, no `experimentalDecorators`.

### Registering the transform

Three ways, same plugin object:

```toml
# bunfig.toml — for `bun run` and `bun test`
preload = ["@dunx/compiler/preload"]

[test]
preload = ["@dunx/compiler/preload"]
```

```bash
bun --preload @dunx/compiler/preload src/main.ts   # no config file at all
```

```ts
await Bun.build({ entrypoints: ['src/main.ts'], plugins: [depsPlugin] });
```

`@dunx/create-app` scaffolds the first of these, so a generated app needs no setup.

### Why `@dunx/core` does not register it itself

The obvious "built in" move is for `@dunx/core` to call `Bun.plugin()` when it is
imported. It was rejected twice over.

It would make DI **import-order dependent**. Bun's `onLoad` only affects modules
loaded after registration, and static imports are evaluated depth-first in source
order. `import { AppFactory } from '@dunx/core'` before
`import { AppModule } from './app.module.js'` would work; the reverse order would
silently skip the transform. That is precisely the "`reflect-metadata` must be the
first import" fragility this framework exists to avoid, and no amount of
documentation fixes an ordering rule.

It would also cost `@dunx/core` its empty dependency list. The transform needs
`oxc-parser`, a native binary, which every production deployment would then carry
in order to run code that was already transformed at build time.

So registration stays explicit, and the failure mode is closed off instead:

### The missing-transform guard

`Function.prototype.length` still reports the declared parameter count after
TypeScript's parameter properties are compiled away (measured: a constructor with
two parameter properties has `length === 2`). So the container can tell the
difference between "this class needs nothing" and "nobody told me what this class
needs". No recorded dependencies plus a non-zero arity means the plugin never saw
the file, and that is a boot error carrying the fix:

```
UsersController declares 1 constructor parameter(s) but no dependencies were
recorded for it, so @dunx/compiler did not transform UsersController.
Register the plugin, then retry:

  # bunfig.toml
  preload = ["@dunx/compiler/preload"]
```

The check cannot produce a false positive. A constructor whose parameters all have
defaults has `length === 0` and is genuinely callable with no arguments; a class
bound with `useValue` is never constructed; and the transform only ever writes a
record whose length equals the parameter count, so a present record is never empty.

Three properties follow, and each is strictly better than the
`emitDecoratorMetadata` equivalent measured above:

**Erased types are named, not degraded.** `emitDecoratorMetadata` turns an
interface into `Object` and a primitive into `Number`, which is why Nest needs
`@Inject(TOKEN)` for both. The transform can see the difference in the source, so
it records the parameter as `unresolved` along with its original text, and the
container throws at boot naming it:

```
UsersService cannot be constructed: parameter 2 (private readonly cfg: AppConfig)
names nothing that exists at runtime, so there is no token to resolve.
```

A type-only import, an inline `type` specifier, a local `interface` or type alias,
a class type parameter, a primitive, and a union are all detected this way.

**The record is a thunk, so there is no temporal dead zone.** An eagerly
evaluated array would crash on a dependency declared later in the file or reached
through a circular import. Deferring the body to resolution time is what removes
the need for `forwardRef`.

**Inheritance falls out of the prototype chain.** `readDeps` does a plain lookup
rather than `Object.hasOwn`, so a subclass that declares no constructor inherits
its base's constructor _and_ its base's dependencies. A subclass that does declare
one gets its own record, which shadows the base's.

Two limits worth recording. The transform only rewrites **class declarations**: a
`ClassExpression`'s own name is bound inside the class body, so a statement
appended after `const X = class Inner {}` could not reference `Inner`. And because
a plugin sees one file at a time, it cannot tell a DI provider from a plain data
class — `new HttpError(404, 'x')` also has constructor parameters. So it records
metadata for every annotated class and lets the container raise the error only if
something is actually resolved as a provider. That is why the error is a boot
error and not a build error.

`inject()` remains available for a value with no constructor parameter to hang
off, and both mechanisms may be used in the same class.

## Core primitives (`@dunx/core`)

There is no `@Injectable()` — every class is injectable by default.

| Primitive                                              | Purpose                                                  |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `constructor(private readonly x: X)`                   | The default. Resolved from the parameter's type          |
| `inject<T>(token): T`                                  | Escape hatch, in a field initializer. Always synchronous |
| `token<T>(name)`                                       | Opaque token for interfaces, config objects, primitives  |
| `provide(token, {useClass \| useValue \| useFactory})` | Binding, including async factories                       |
| `@Module({imports, providers})`                        | Class decorator. Registration only — see below           |
| `AppFactory.create(RootModule)`                        | Builds, resolves, runs `onInit`. Returns a live `App`    |

`AppFactory.create()` is async and there is no separate `init()`: resolution is
eager, so an app that exists is an app that booted. `app.enableShutdownHooks()`
registers `SIGTERM`/`SIGINT` handlers and `app.closed` resolves once shutdown has
finished, whoever triggered it.

### `token()` is the escape hatch, not the default

Anything that is a **runtime value** can be its own token, so most code needs no
`token()` call at all. In order of preference:

1. **A concrete class** — `inject(Config)`. Nothing to declare; an unbound class
   self-binds.
2. **An abstract class** for a contract whose implementation is built elsewhere.
   It is a runtime value, so it works as a token, and it cannot be constructed, so
   the container will not self-bind it by accident:

   ```ts
   export abstract class Database {
     abstract query(sql: string): readonly string[];
   }
   provide(Database, { useFactory: connect, inject: [Config] });
   ```

3. **`token<T>(name)`** only for what has no runtime value to name: a primitive
   (`token<string>('Dsn')`), or a value whose type you do not own and cannot
   subclass.

An `interface` is erased at compile time, so `inject(SomeInterface)` cannot exist —
that is the same erasure the `emitDecoratorMetadata` measurement above shows
degrading to `Object`. Replacing the interface with an abstract class is what makes
the token disappear. `examples/full` uses zero `token()` calls for this
reason.

`token<T>()` returns a **unique object**; the name is only a label for error
messages. Two `token<Config>('config')` calls are two distinct tokens, so nominal
collision is impossible and no prefixing convention is needed. Class tokens key on
the constructor reference, so two same-named classes never collide either.

One erasure cost to know: `abstract` does not exist at runtime, so an abstract
class that is injected but never bound gets self-bound and constructed into a
useless object rather than erroring. TypeScript blocks it in the `providers` array
(a bare entry must be constructible), but not at the `inject()` call site.

`@Module` is a marker, not a container. It writes its options onto the class as a
`Symbol.for('dunx.module')` property — the same technique as route discovery, no
accumulator — and the class is **never instantiated**. Reading it uses
`Object.hasOwn`, so subclassing a module does not inherit its bindings; that
throws instead. The class name is where the duplicate-binding error gets "bound by
module X and module Y". `controllers` and `middleware` arrive with Phase 2, since
there is nothing to put in them until there is HTTP.

A bare class in `providers` is shorthand for binding it to itself, so the ordinary
case carries no function calls at all:

```ts
@Module({ providers: [UsersService, UsersRepository] })
export class UsersModule {}
```

`provide()` is only needed where a token is genuinely being bound — an interface, a
config object, an async factory — which is exactly where Nest needs its object form
too. It stays a **call** rather than a `{ provide, useValue }` literal because
per-element type inference across a heterogeneous array requires one: that is
precisely why Nest's `useValue` is untyped, and dunx's is checked against the
token's type.

```ts
@Controller('users')
export class UsersController {
  private users = inject(UsersService); // a class is its own token
  private cfg = inject(Config); // so is a config class
  private db = inject(Database); // abstract class, bound by a factory
}
```

### Resolution mechanism

Constructor arguments are resolved **before** the injector swap, because argument
resolution recurses back through `get()` and must not see the class being built as
its own scope. Then a module-level `currentInjector` is set around the `new
Klass()` call itself, so any `inject()` in a field initializer resolves against
it. Field initializers run synchronously inside the constructor, so there is no
async gap and no `AsyncLocalStorage` cost. Calling `inject()` outside construction
throws with a clear message.

Both paths go through the same `get()`, so cycle detection, duplicate-binding
rejection, and the async-factory retry below apply identically whether a
dependency arrived as a constructor parameter or an `inject()` call.

### Eager-only, no lazy resolution

`AppFactory.create()` instantiates every provider and awaits async factories
before the server binds. Wiring errors surface at boot, not at first request. This
is what lets `inject()` stay synchronous: by the time any constructor runs, every
async provider is already resolved.

There is no static graph to topologically sort — `inject()` calls are only
discovered by running the field initializers. So construction is recursive and
synchronous, and an async factory reached from inside a constructor parks its
promise, throws a private signal to unwind, and the async caller awaits the token
and **retries the construction**. Each retry resolves at least one more async
binding, so it terminates in at most one pass per async dependency, and a factory
is never invoked twice because the promise is parked before the signal is thrown.
The cost is that a constructor aborted this way runs its already-evaluated field
initializers again, which is why field initializers must stay pure wiring.

For the same reason a factory cannot use `inject()`: after its first `await` the
module-level current injector is no longer its own. Factory dependencies are
declared instead, and inferred into the factory's parameters:

```ts
provide(Database, {
  useFactory: connect, // (config: Config) => Promise<Database>, inferred
  inject: [Config],
});
```

### Singleton lifetime only

Request-scoped DI is Nest's single biggest source of complexity and per-request
cost. Per-request state is passed as an explicit `ctx` argument instead.
Request-scoped _context_ (logging correlation and similar) stays a separate
`AsyncLocalStorage` concern that never touches the container.

### Cycle detection

A `building` set tracks in-flight construction and throws with the full cycle
path. Without it, a field-initializer cycle is an unbounded recursion with an
unreadable stack.

## Modules group registrations; they do not encapsulate

The syntax is Nest's. The semantics are not, and that distinction is the whole
point — an earlier draft of this document argued for plain-object modules, but the
argument was always about semantics and the object literal was never load-bearing.

The container is flat. `imports` exists, but it is **traversal only** — it pulls a
module's registrations into the same flat container. There is no `exports` list, no
visibility boundary, and therefore no "provider is not exported from module X"
error. `AppFactory.create(RootModule)` walks the import graph, imports before
importers so dependencies register first, and visits each module once — which makes
a diamond import register once rather than tripping the duplicate-binding check,
and makes a circular import terminate instead of erroring. A module is a named list
of registrations and a list of other modules to include.

So the encapsulation Nest gives you is absent by design. It is also largely
recoverable elsewhere: `inject(BillingService)` needs a value import of
`BillingService`, so cross-domain coupling is already visible in the import graph
and enforceable with a lint boundary rule at zero runtime cost. What is genuinely
lost is per-module _rebinding_ — a `LOGGER` token bound differently in two
features. Use two tokens. That is the price of the flat container.

This is the largest deliberate divergence from Nest and the first thing users
will notice. It should be loud in the README.

Two modules binding the same token is therefore a real hazard, and last-wins would
be silent. `app.init()` collects every module's registrations into one flat list
and **throws on a duplicate token**, naming both modules — the same rule as route
collisions.

That leaves no room for overrides to be an extra module that wins, so
`createTestApp({ modules, overrides })` does not append. It assembles the same flat
list and **replaces in place**, keyed by token; an override naming a token nobody
binds is itself an error. The count per token never changes, so the duplicate check
still runs unmodified and there is no bypass. Replacement also means a discarded
provider's factory never runs — which matters when it is the async `useFactory`
that opens the real database.

Built, as `AppFactory.create(root, { overrides })` in core with `@dunx/testing`
wrapping it. See "Test harness (`@dunx/testing`)" below for what that cost.

## Configured modules, and why there is no `forRootAsync`

A module that needs options exposes a static factory returning a `DynamicModule` —
its own identity plus the registrations that configuration implies:

```ts
export class RedisModule {
  static forRoot(options: RedisOptions): DynamicModule {
    return {
      module: RedisModule,
      providers: [
        provide(RedisOptions, { useValue: options }),
        RedisConnection,
      ],
    };
  }
}

@Module({ imports: [RedisModule.forRoot({ url: 'redis://localhost' })] })
export class AppModule {}
```

The `module` field is the identity, so error messages still name a module and the
traversal can tell two configurations of one module apart. Registrations from a
configured module are **merged** with whatever the class's own `@Module` decorator
declares, which lets a module have a static core plus configured extras. A class
used only through its factory needs no decorator at all.

**Nest's `forRootAsync` has no counterpart, because it needs none.** Its whole
purpose is to build options from other injected providers, asynchronously. dunx
resolves eagerly and awaits every async factory before any constructor runs, so
that is already just a provider:

```ts
static forRootAsync(load: () => Promise<RedisOptions>): DynamicModule {
  return {
    module: RedisModule,
    providers: [provide(RedisOptions, { useFactory: load }), RedisConnection],
  };
}
```

One mechanism, not two. The eager-resolution decision paid for itself here.

### Deduplication is per-reference, not per-module

A bare class is visited once however many modules import it — that is what makes a
diamond import register once rather than tripping the duplicate-binding check. The
same `DynamicModule` **object** imported twice is likewise visited once.

Two _different_ configurations of one module are deliberately **not** deduped. They
both register, and the existing duplicate-token check reports them by name:

```
Duplicate binding for Options: bound by module "StoreModule" and module "StoreModule".
```

Last-wins would have been silent, and "first wins" would depend on traversal order.
Neither is something a reader could predict, so both configurations register and the
conflict surfaces. This reuses the flat container's existing rule instead of adding
a second one.

## One extension point, not five

Nest has middleware, guards, interceptors, pipes, and filters. dunx has:

```ts
interface Middleware {
  handle(
    req: BunRequest,
    ctx: RouteContext,
    next: () => Promise<Response>,
  ): Promise<Response>;
}
```

A guard is still middleware that throws — there is no `CanActivate`. What
`@UseGuards`, `@Roles` and `@Public` added is not a sixth extension point but a
**scope** and a **metadata channel** for the one that already existed. `ctx.get(key)`
reads metadata merged handler-first-then-class at discovery, so a method-level
`@Public()` overrides a class-level `@Roles()`.

Guards are middleware that throw. Interceptors wrap `next()`. Pipes become
schema validation in the route options. Filters become one error mapper. Chains
compose into a single closure per route **at boot** — no per-request array
iteration.

## Params without parameter decorators

Standard decorators have no parameter decorators, so `@Body()` / `@Query()` are
off the table. Schemas move onto the route decorator:

```ts
@Post('/', { body: CreateUser, query: Paging })
create(req: BunRequest<'/users'>, input: { body: CreateUser; query: Paging }) {}
```

Validation targets the **Standard Schema** spec (`~standard.validate`), so
Zod 4, Valibot, and ArkType all work with zero dependencies in `@dunx/*`.

## HTTP adapter (`@dunx/http`)

`HttpFactory.create(RootModule, options?)` boots the container via
`AppFactory.create`, then:

1. Collect controllers from `@Module({ controllers })` across the import graph
2. Discover routes per controller by walking the constructed instance's prototype
   chain (see **Route discovery**). Zero routes throws
3. Join controller prefix + method path, normalize
4. **Detect collisions and throw** — Bun silently lets one route win
5. Build the `routes` object; each handler is a closure over the
   already-constructed instance and its bound method, with the middleware chain
   already folded in
6. Hand to `Bun.serve`

Step 2 needs the instance, not just the class, so that the handler can be bound off
it — which is what makes an undecorated override in a subclass dispatch correctly.
That ordering is guaranteed: container resolution is eager and completes first.

Field-initialized routes are part of **Route discovery** but not yet implemented:
the thing that produces them is the `route.*` builder, which exists to sidestep the
decorator inference limit, so it lands with Phase 3 rather than as a scan with no
producer.

Middleware is a **class** with `handle(req, ctx, next)`, resolved from the container
so it gets constructor injection. Global middleware is passed to
`HttpFactory.create` or `app.use()`, not to `@Module` — in a flat container with no
module boundary, "module middleware" could only ever mean global middleware, so
hanging it off a module would imply a scope that does not exist.

`@UseGuards(...)` is different, and the distinction is worth keeping straight: it
hangs off a **class or a method**, which are real scopes that do exist. Ordering is
global outermost, then class-level, then method-level, then the handler.

Per request the framework does exactly four things: validate declared schemas,
call the method, pass a `Response` through or wrap the return in
`Response.json()`, and map thrown errors. No lookup, no DI, no metadata read —
route metadata and the `RouteContext` join the **boot-time** set, not the
per-request one. The context is frozen and shared by every request to its route, and
`ctx.get` is a `Map` lookup over an already-merged record rather than a prototype
walk.

## Route discovery

Both original candidates were measured and both fail — see **Verified
constraints**. `ctx.metadata` is unreadable without polyfilling `Symbol.metadata`
and shares mutable state up the prototype chain. A global pending array drained by
the class decorator hands a base class's routes to whichever subclass is defined
first, and leaks decorated methods across files.

Both were **accumulators**: they recorded routes at class-definition time and
needed a class decorator to close the record. Every failure above traces to that.
So stop accumulating.

A method decorator sets a symbol property on the function it receives and returns
it. Nothing is recorded anywhere else. At boot the adapter _discovers_ routes by
inspection:

1. Walk `Object.getPrototypeOf` from the controller's prototype, reading
   `Object.getOwnPropertyDescriptors` at each level. A marked `descriptor.value`
   is a route; most-derived wins on a repeated name.
2. Read `Object.entries(instance)` for field-initialized `route.*` builders, which
   carry the same marker.

Consequences, all measured:

- **No accumulator, so no ordering dependence and no cross-file leak.** An
  undecorated class's marked methods are never reached, because its prototype is in
  no other class's chain.
- **No class decorator is required at all** — and so no `@Routes()`. Inheriting
  from an undecorated abstract base works for any number of subclasses.
  `@Controller` is reduced to supplying a prefix and may be omitted;
  `@Module({ controllers })` is what registers a controller. The prefix is read
  through the prototype chain rather than with `Object.hasOwn`, so a subclass
  inherits its base's prefix and two subclasses of one decorated base collide
  loudly at boot instead of silently mounting at the root.
- **Overriding a decorated base method without re-decorating works.** The own
  undecorated member does not shadow discovery, and dispatch resolves through the
  prototype chain to the override.
- **Decorated methods and field routes are one merged set**, so collision
  detection covers both and a controller resolving to zero routes can throw.

No `Symbol.metadata`, no polyfill, no import-order dependence.

## Database layer (`@dunx/infra/db`)

**drizzle is the database driver, not an option.** An earlier version of this
package shipped a hand-rolled `Database` abstract class with a `sql` tagged
template, `all`/`get`/`run`/`exec`, a `Repository` base and a `quoteIdentifier`
helper, and two implementations satisfying it. All of that is retired.

This is Rule 1's second half — _never invent what a mature library already
solves_ — applied to the one place it was being violated. The hand-rolled contract
was an ORM's front half: it had a query surface, so it would have grown result
mapping, relations, and a migration story, each one a worse version of something
drizzle already ships. The rule's own resolution of the tension is what the layer
now looks like: **the library owns the abstraction, Bun owns the I/O**, via
`drizzle-orm/bun-sqlite` over `bun:sqlite` and `drizzle-orm/bun-sql` over
`Bun.SQL`. No `pg`, no `better-sqlite3`. `drizzle-orm` is an optional
`peerDependency`, so the consumer owns the version and an app that never touches a
database never installs it.

What remains is only what a drizzle handle genuinely lacks:

- **A lifecycle.** `DbConnection` is an abstract class — so it is an injection
  token — holding `close()`, `onShutdown()`, `backend`, `dialect`, and the raw
  driver handle. drizzle has none of these; it does not even know whether its
  driver is open.
- **Module wiring.** `DbModule` binds three tokens: `DbOptions`, `DbConnection`,
  and **drizzle's own database class**. That last one is the whole trick — drizzle's
  `BunSQLiteDatabase` and `BunSQLDatabase` are real runtime classes, so a class is
  usable as a token directly, and `@dunx/compiler` records the bare type name from
  `db: BunSQLiteDatabase<typeof schema>` while ignoring the type argument. One
  erased class is the token; the schema types stay on the annotation. No wrapper
  object, and no `token()` call.
- **An async-safe transaction**, for the bun-sqlite quirk measured above — and a
  synchronous one for when the callback needs no promise at all, below.
- **Data seeding.** `drizzle-kit` owns schema migrations and their journal; it has
  no concept of data. `runSeeds` is numbered files, one transaction per seed
  covering the seed and its journal row, and a separate `dunx_seeds` table so the
  two journals never contend.

Two costs are accepted rather than papered over. `DbModule.forRootAsync` has to
take the token as its first argument, because which drizzle class the token is only
becomes knowable after the options factory has run — too late to register a
provider under it. And because schema modules are dialect-specific (`sqliteTable`
vs `pgTable`), the two backends are a build-time choice; "one `DATABASE_URL` naming
either" is no longer a supported shape, and the old contract only ever supported it
by hiding the differences.

Entity decorators were the alternative considered for the schema and were
**measured and rejected** — see **Verified constraints**, "A decorator cannot
publish a type back onto the class it decorates". drizzle's native object schema is
the supported path.

### Synchronous SQLite mode

`bun:sqlite` is synchronous underneath and `@dunx/http` has a dispatch path that
allocates no promise when a handler returns a plain value, so a request can in
principle go parse → query → respond without yielding. Reads already could —
drizzle's bun-sqlite builders have `.all()`/`.get()`/`.run()`. What stopped a
_write_ was `transaction()`, which returns a promise, so any route that wrote
anything went back to `async`.

`SyncSqliteOptions` closes that. The mode is a **sibling options class, not a
flag**, because the mode decides the handle type and the handle type is what
`DbModule.forRoot` infers the injection token from; a flag would leave that
inference with a union to guess at. Choosing it changes exactly two things: the
token becomes `SyncDatabase`, and `transactionSync(db, fn)` becomes reachable.

**`SyncDatabase` is an empty subclass of drizzle's `BunSQLiteDatabase` with one
declared property, `synchronous: true`.** The property is what stops the two from
being structurally identical, which is the whole mechanism — TypeScript is
structural, so an empty subclass would be mutually assignable and would gate
nothing. `SyncSqliteConnection` defines the property on the handle drizzle built,
so the type is true rather than claimed; it is non-enumerable, so nothing that
walks the handle sees it. The relationship stays one-way on purpose: a
`SyncDatabase` **is** a `BunSQLiteDatabase`, so `transaction()`, `runSeeds` and
repositories written before the mode existed all still take one. Synchronous mode
is a superset, not a fork.

Two type-level gates, both compile errors:

- A service annotating `SyncDatabase` in an app configured with `SqliteOptions`
  fails to resolve at boot — nothing bound that token.
- `transactionSync`'s callback is constrained to a non-thenable return, so an
  `async` callback does not compile.

That second one is the interesting half, because **it inverts the finding above.**
`transaction()` exists because drizzle's bun-sqlite transaction commits when the
callback returns, so an async callback commits before its first `await` resumes.
Every part of that failure is downstream of the callback being asynchronous. Remove
the promise and `bun:sqlite`'s own wrapper is exactly right, so `transactionSync`
**delegates to drizzle's `db.transaction()`** instead of issuing `BEGIN`/`COMMIT`
itself: no statement strings, no serialising queue, no promise. Verified on Bun
1.3.14 — a synchronous callback that throws leaves no row, an async one leaves the
row, which is the pair the workaround was built for. Verified too that the two
compose: a `transactionSync` opened while an async `transaction()` is suspended
across an `await` takes a **savepoint** rather than failing, because `bun:sqlite`
branches on `Database.inTransaction`, which the outer `BEGIN` has already set.

**There is no Postgres counterpart and there will not be one.** `Bun.SQL` is a
socket. The asymmetry is structural rather than documented — `SqlOptions` simply has
no sync sibling, and `transactionSync` does not accept a `BunSQLDatabase` — so the
API cannot pretend the two backends are symmetric.

One deliberate ugliness: `SqliteConnection` gained a second type parameter for the
handle, and assigns it with `as unknown as TDb`. The alternatives were a subclass
redeclaring `db` — which TypeScript 7 rejects as `declare override`, and which
without `declare` would define the field as `undefined` over the base's assignment —
or a standalone `SyncSqliteConnection` that is not a `SqliteConnection`, breaking
`connection instanceof SqliteConnection` for the raw-handle escape hatch. One cast
in one constructor, immediately made true by the subclass, was the smaller cost.

#### What it measures, which is less than the pitch

`tools/bench`'s `bun run db-modes` runs the comparison end to end through a real
`Bun.serve`, interleaved round-robin for the reason the validation harness records.
Two scenarios per mode, `requestLogging: false` so every route stays on the direct
dispatch path: a single indexed `SELECT`, and a transaction doing two `UPDATE`s and
a read. An earlier version inserted rows instead of updating them and had to be
thrown away — the table grew under later rounds, so the write scenario measured its
own history (σ was twice the median).

AMD Ryzen 9 5950X, 32 threads, Bun 1.3.14, oha 1.15.0, 64 connections, 11 rounds of
5 s, medians:

| unit          | req/s  |    σ | p50 ms | p99 ms |
| ------------- | ------ | ---: | ------ | ------ |
| `read:async`  | 17,625 | 1368 | 3.473  | 7.002  |
| `read:sync`   | 18,399 | 1411 | 3.268  | 6.729  |
| `write:async` | 7,942  |  370 | 7.435  | 15.580 |
| `write:sync`  | 8,283  |  410 | 7.104  | 15.140 |

**Synchronous mode is ~4–6% more req/s and ~0.2–0.3 ms off p50**, reproduced across
two independent runs (read +5.7% then +4.4%; write +4.2% then +4.3%). Say the rest
of it plainly: σ on the read rows is ~8% of the median, so a single round proves
nothing and the per-round ranges overlap. The effect is real — it is consistent in
direction across 18 rounds and both scenarios — but it sits at the edge of this
box's noise floor, not comfortably above it. At ~57 µs of service time per request,
the saving is roughly 3 µs: one async frame, one promise from drizzle's thenable
builder, one promise adoption in the dispatch path.

The framing that motivated the work — "one API call could be 5–10 ms instead of
30–50 ms" — is **right about SQLite and wrong about this feature**. That difference
is an embedded database versus one over a network, and an app gets it from
`SqliteOptions` just as much as from `SyncSqliteOptions`. What sync mode buys on top
is single-digit percent, plus a request path with no promise in it at all, which is
worth having and is not worth overselling.

## Build & packaging

Bun-only, so the ESM/CJS/types triple build is wasted work.

- **ESM only.** One `tsconfig.json` per package.
- `Bun.build` emits JS: `target: 'bun'`, `format: 'esm'`,
  `packages: 'external'` (relative imports bundle, dependencies stay external),
  `sourcemap: 'linked'`.
- `tsc --emitDeclarationOnly` emits the `.d.ts` tree. Bun has no `--dts`.
- Relative imports in source **must** carry a `.js` extension. `tsc` copies the
  specifier verbatim into `.d.ts`, and an extensionless specifier fails to
  resolve for consumers on `moduleResolution: node16`/`nodenext`.
- `"type": "module"` is required in every package manifest. Without it,
  `verbatimModuleSyntax` reports `TS1287` against ESM syntax.

Both halves run from the shared `scripts/build-package.ts`, so there is one
implementation for every package.

`tools/*` is outside all of this. Those workspaces are `"private": true`, never
published, and build with whatever suits them — `tools/docs` is a React bundle,
not a `Bun.build` package. Rule 1 constrains what dunx ships; it does not
constrain what builds its website.

## Documentation site (`tools/docs`)

React + Mantine over **Vite**, static output, deployed to GitHub Pages. It replaced the
coverage report as the Pages root; coverage is now a page inside it.

**The bundler was `Bun.build` and was moved back to Vite, by measuring rather than
by preference.** The original swap traded ~25% more gzipped JS for a 41 ms build
against Vite 5's 1.7 s. Vite 8 ships Rolldown, which removed the speed argument,
and the size argument had grown as Mantine and `@mantine/charts`/recharts entered
the graph. Same site, same content, both bundlers, gzip -9:

| Bundler           | JS raw    | JS gzip      | CSS raw  | CSS gzip | Build   |
| ----------------- | --------- | ------------ | -------- | -------- | ------- |
| `Bun.build`       | 1829.6 KB | **506.5 KB** | 312.4 KB | 35.0 KB  | ~0.15 s |
| Vite 8 (Rolldown) | 1558.1 KB | **426.8 KB** | 212.5 KB | 31.2 KB  | ~0.30 s |

83.5 KB less over the wire, for 150 ms nobody waits on — a docs site is built in
CI and read over a network. What the move costs, and what has to move with it if
it is ever reversed:

- Text imports are Vite's `?raw`, not `with { type: 'text' }`. `src/env.d.ts`
  declares `*?raw` locally rather than pulling `vite/client` in, which would mean
  overriding the root tsconfig's `types`. `happydom.ts` registers a `Bun.plugin`
  teaching the test runner the same suffix — the runner is still `bun test`.
- `public/` copying and the `dist/` clean are Vite's; `scripts/build.ts` is gone.

**The site carries a projection of the benchmark report, not the report.**
`results/latest.json` holds every run's samples, each scenario's expected body and
each subject's entry file — evidence for the harness, and ~48 KB of JSON that
reaches no pixel. `scripts/extract/bench.ts` narrows it to what renders, which is
10.6 KB. `BenchReport` in `model.ts` stays the harness's mirror; `BenchModel` is
the site's shape, and a field surviving the projection means something renders it.

**A README is rendered minus its repo-plumbing sections.** A package page showed
`## Install`, `## License` and the monorepo's own build instructions, which are
for someone working in this repository and not for someone reading the docs.
`siteMarkdown` in `scripts/content.ts` drops a `##` section whose slug matches
`EXCLUDED_SECTIONS` with a `-` word boundary — so `## Install it as a
devDependency` goes with `## Install` — plus the centered title-and-badges block
every README opens with. The list is published in `tools/docs/README.md`, and an
author decides which side a section falls on by naming it. Guides under `docs/`
are exempt: they _are_ repository documentation, and dropping sections from them
would lose real content.

**The API reference is extracted, not written.** `tools/docs/scripts/extract/`
parses every `packages/*/src/**/*.ts` with **`oxc-parser`** — the parser
`@dunx/compiler` already depends on — and reads three things off each exported
declaration:

- the **signature**, sliced from the source text between AST offsets (from the
  declaration's start to its body's start). The signature is therefore the one
  that was _written_, which for annotated source is better documentation than a
  checker-normalised expansion.
- the **doc comment**, bound by adjacency: a `/** */` block with nothing but
  whitespace between it and the declaration.
- the **public surface**, by resolving each manifest `exports` entry to its
  source entrypoint and following `export * from` / `export { x } from` through
  the module graph. A symbol no entrypoint reaches is marked internal.

TypeScript's own API was the alternative and was rejected: the only thing it
adds is _inferred_ types for un-annotated declarations, which this codebase
barely has, in exchange for running a full type checker over five packages at
build time. What that costs is recorded in `tools/docs/README.md` along with the
gaps it leaves — no cross-package type links, no namespace re-export expansion,
one entry per overload set.

Two details worth not re-deriving:

- **Routing is hash-based** (`#/api/core`). GitHub Pages serves static files
  with no SPA fallback, so a path router 404s on every deep link. A symbol is
  `#/api/core?h=symbol-ConsoleLogger`, and three things have to hold together
  for that to land: the search action has to emit the `?h=`, the package page
  has to open its API tab in response to it (`Tabs` is `keepMounted={false}`, so
  the card does not exist on the readme tab), and the scroll has to keep looking
  across frames because the card mounts a commit after the route changes. All
  three were wrong at once, which is why a search hit opened the package readme.
- **The frozen-object-plus-union `enum` replacement declares one name twice**, as
  a value and as a type. The extractor merges both declarations into one entry;
  keying by name alone would document half the construct.

`scripts/coverage-report.ts` writes into the site rather than publishing
standalone: the model to `tools/docs/src/generated/coverage.json`, the badges to
`tools/docs/public/badges/`, which the build copies to `/badges/`. CI therefore
rebuilds the site after `test:cov`, because the first build (inside
`bun run build`) predates the coverage data.

## Scaffolder (`create-app`)

`@dunx/create-app` gets all three invocations from one package name:

```
bun create @dunx/app my-app
npm  create @dunx/app my-app
bunx @dunx/create-app my-app
```

Zero dependencies, Node-targeted (so `npx` works for people who have not
installed Bun yet, and can then tell them to), templates as directories with
token replacement. No network, no degit.

## Roadmap

Exit criteria are written as individually checkable statements on purpose.
`/whats-next` reads this section to place the work and to fill in `HANDOFF.md`'s
next steps, so a criterion that cannot be verified against the tree by inspection
is a criterion that gets reported wrong. Keep them mechanical.

The phases below are written from the framework's point of view.
[MIGRATION-FROM-NEST.md](./MIGRATION-FROM-NEST.md) is the same roadmap seen from
a migrating NestJS application, and it argues for two reorderings: route metadata
moves into Phase 2, and OpenAPI ahead of Phase 4. Read it before planning a phase.

### Phase 1 — DI proven end to end

Ship `@dunx/core` and a single `examples/full` app that boots a fully
dependency-injected application graph **with no HTTP at all**.

Keeping HTTP out is the point. If the example can only be evaluated by curling
it, ergonomic problems in the container hide behind routing. A no-HTTP example
forces `inject()`, tokens, async factories, and shutdown ordering to stand on
their own.

Exit criteria:

- `inject()` resolves classes and tokens, with inference and no manual generics
- `provide()` covers `useClass`, `useValue`, and async `useFactory`
- `@Module()` composes across at least two feature modules
- A circular dependency throws a readable error naming the full cycle
- `onInit` / `onShutdown` run in dependency order; `SIGTERM` closes cleanly
- Resolving a provider twice returns the same instance
- The example runs via `bun start`, exits 0, and CI asserts that

`examples/full` is one app that grows through the phases, not a new example per
phase. It was `examples/playground` until the examples were restructured; the rename
is cosmetic, but what sits beside it now is not.

Where a part needs a service CI does not have (Redis, Postgres, S3), it reports that
it is skipping and the app still exits 0 — otherwise CI teaches everyone to ignore
it.

#### Per-package examples were reverted; a ladder of four replaced them

The original decision — recorded here as "seven apps meant seven bootstraps to keep
alive and nowhere that showed the packages composing" — **stands, and was not
reversed.** What changed is that "one example" turned out to be the wrong reading of
it. There are now four, and the distinction is that they are not one per package:

| Example              | Answers                                                         |
| -------------------- | --------------------------------------------------------------- |
| `examples/minimal`   | "what does this framework look like?" — five files, two minutes |
| `examples/databases` | "how do I set up my database?" — SQLite ×2, Postgres, MySQL     |
| `examples/testing`   | "how do I test it?" — overrides, a real server, a guard         |
| `examples/full`      | "does it all actually compose?" — every package, one service    |

Each is a **question an evaluator asks in order**, not a package with a demo bolted
on. `@dunx/http` has no example of its own and never will; it appears in all four.
`full` is still the only place the packages are shown composing, which is what the
original objection was about, and it did not shrink to make room for the others.

**The maintenance objection still stands and is the binding constraint.** Every
example is a bootstrap that rots the moment nobody runs it, so each is wired into
CI the same way `full`'s `tour` is — `bun run --filter '@dunx/example-*' test` runs
all of their suites, and `full` additionally runs its `tour`. An example that cannot
be kept alive by CI does not get added. That is the whole test for whether a fifth
one earns its place, and it is why several plausible candidates were rejected:

- **An auth example.** It would be `full`'s `src/auth/` copied with the rest deleted:
  same better-auth config, same schema, same guard, no new question answered.
- **A queue / background-worker example.** Its entire subject needs Redis, so in CI
  it would skip and demonstrate nothing. `full`'s `bun run worker` already isolates
  the two-process shape, which is the part that is genuinely hard to see.
- **An OpenAPI-first example.** `full` already generates the document from the zod
  schemas its routes validate against; a second app would only have fewer routes in
  it.

#### `examples/databases` is one app with four configurations, not four apps

Four containers run in sequence inside one process, because the container is flat
and each backend binds its own `DbConnection` — two in one app would be a duplicate
token. One workspace rather than four is less to keep alive, and it puts the
SQLite-async and SQLite-sync services in adjacent files, which is where the choice
between them is actually made.

It uses `AppFactory`, not `HttpFactory`. That is the same argument Phase 1 makes
above: with no HTTP, nothing about the database wiring can hide behind a route.

MySQL is the interesting part, and it is a **fifth backend that `@dunx/infra/db`
does not ship**, assembled in the example in about forty lines with no change to the
package — which is the strongest available evidence that `DbOptions.open()` is the
right seam. drizzle has no Bun-native MySQL driver, so it is `drizzle-orm/mysql-proxy`
with `Bun.SQL` as the transport: drizzle owns the dialect, Bun owns the socket, and
`mysql2` is never installed. Verified against MySQL 8; the callback contract, the
two `Bun.SQL` bugs it works around, and the transaction gap are all in
[bun-apis.md](./bun-apis.md), "`Bun.SQL` and `bun:sqlite`".

Promoting it into `@dunx/infra/db` as a `MysqlOptions<TSchema>` is a reasonable next
step and deliberately not taken here: the example is the place to prove it works
before it becomes a supported surface with a schema type parameter to maintain.

### Phase 2 — HTTP

`@dunx/http`, the `Bun.serve` adapter, the middleware chain, the error mapper,
and route-collision detection. `examples/full` grows a controller; its Phase 1
assertions keep passing unchanged.

Also `@dunx/compiler`, the load-time transform that makes constructor injection
work. It landed here rather than in Phase 1 because the need only became clear
once real application code was being written against `inject()`.

Exit criteria:

- A class with constructor parameters resolves without any annotation
- A parameter whose type is erased fails at boot naming that parameter
- A subclass with no constructor of its own inherits its base's dependencies
- `inject()` still works, and both mechanisms work in one class
- `examples/full` uses constructor injection throughout and `bun start` exits 0

### Phase 3 — Validation

Standard Schema wiring and typed route input. Gated on the inference spike
below.

### Phase 4 — Testing & scaffolder

`@dunx/testing` (`createTestApp({ modules, overrides })`, real server on port 0)
and `@dunx/create-app`.

### Phase 5 — OpenAPI — **built**

`@dunx/openapi` generates an OpenAPI 3.1 document from the zod schemas already on the
route decorators and serves self-contained HTML. Security requirements come from the
guards' own `@Public()` / `@Roles()` metadata. Zod is a `peerDependency`; the per-vendor
adapter this section anticipated is a vendor check around `z.toJSONSchema`.

## Spikes to resolve

Run through `/spike`: measure on real Bun, record the result under **Verified
constraints** above, then delete the item from here. A spike that changes the
public API shape belongs before the code it gates.

None open. Route input inference was the last one; its result is recorded under
**Verified constraints** above.

## Authentication (`@dunx/auth`)

**better-auth is the authentication system.** `@dunx/auth` is the wiring around it and
nothing else: no sign-in flow, no session table, no password reset, no OAuth dance.
Rule 1's second half is not a close call here — an auth system is years of edge cases,
and a half-built one is a liability dressed as a feature. `better-auth` is an optional
`peerDependency`, as is `drizzle-orm` behind the `@dunx/auth/drizzle` subpath.

### `better-auth` is a required peer, `drizzle-orm` an optional one

`@dunx/auth` exists to mount better-auth, and `module.ts` imports `betterAuth` as a
**value**, so `dist/index.js` cannot load without it. Declaring it
`optional: true` would promise something the build does not honour — a consumer who
skipped it would get a module-resolution crash on import rather than the install-time
warning a required peer produces.

`drizzle-orm` stays optional because only the `@dunx/auth/drizzle` subpath imports
it, and `dist/index.js` contains no reference to it — verified rather than assumed.
That is the same test `@dunx/infra` passes for its five other subpaths: a peer is
optional exactly when the entry point a consumer imports does not need it.

### Why a new package rather than `@dunx/infra/auth`

The guard is `@dunx/http` middleware and reads `@dunx/http`'s `PUBLIC` and `ROLES`
metadata keys, so the code needs `@dunx/http`'s types. `@dunx/infra` must not depend
on the web layer — the same coupling was proposed for a request logger in `/logger`
and refused for the same reason: `@dunx/infra` is what a CLI script, a seeder or a
queue worker imports, and none of those have an HTTP server. A package that pulled
`@dunx/http` in behind `@dunx/infra/db` would put a route table in every one of them.

So the dependency runs the other way: `@dunx/auth` depends on `@dunx/core` and
`@dunx/http`, and on `@dunx/infra` **not at all**.

### Not depending on `@dunx/infra`, while still using its connections

`drizzleDatabase(connection)` and `redisStorage(connection)` are the two adapters that
matter, and both would naturally import `DbConnection` and `RedisConnection`. Neither
does. `DrizzleSource` (`{ dialect, db }`) and `RedisStore` (six methods) are **restated
structurally**, exactly as `@dunx/http` restates Standard Schema and for the same
reasons: `@dunx/infra`'s real classes satisfy them with no adapter in between, a bare
`drizzle({ client, schema })` handle works too, and the package's dependency list
stays at two.

The concrete forcing function was a build-order race. `@dunx/infra` as a
`devDependency` of `@dunx/auth` is not an edge `bun run --filter '*'` orders on, so
`tsc --emitDeclarationOnly` in `@dunx/auth` ran against a `packages/infra/dist` that
had just been `rm -rf`'d. Type-only imports would not have helped — tsc needs the
`.d.ts` either way. Restating removed the edge instead of sequencing it.

`drizzleDatabase` also lives on its **own subpath**, because it imports
`better-auth/adapters/drizzle`, which imports `drizzle-orm`. On the main entry that
would make `drizzle-orm` a hard requirement for a Prisma or MongoDB user.

### The instance is bound under an abstract class

`betterAuth()` returns a plain object, so there is no class to use as a token. `Auth`
is an abstract class whose five members are **aliases of better-auth's own** —
`Instance<O>['handler']`, `Instance<O>['api']`, and so on — which a real instance
satisfies structurally. Same shape as `Logger` and `RequestContext` in `@dunx/core`,
and it is what makes `constructor(private readonly auth: Auth)` work at all.

It is generic over the options, which is the `BunSQLiteDatabase<typeof schema>` trick
again: the token is the erased class, the type argument rides on the annotation, so
`Auth<typeof authOptions>` recovers the plugin-widened `api`. Measured: assigning
`betterAuth(opts)` to `Auth<typeof opts>` typechecks, and **widening `Auth<O>` to
`Auth<BetterAuthOptions>` does not** — `$context` is invariant through
`PluginContext<O>`. So the module narrows the token variable rather than widening the
value, the same move `DbModule` makes with `DbConnection`.

`Auth`'s constructor throws when `new.target` is `Auth` itself, copying
`RedisConnection`: every class self-binds in the container, and an unbound abstract
token would otherwise resolve to an object whose every member is `undefined`.

### Mounting: five wildcard routes, and Bun is still the router

`Bun.serve({ routes })` matches `<basePath>/*` natively — verified on Bun 1.3.14,
including that it does **not** match the bare `<basePath>`, which better-auth has no
endpoint at. `AuthHandler` declares one route per verb (`GET`, `POST`, `PUT`, `PATCH`,
`DELETE`; the last three because a plugin may declare them) and each returns
`auth.handler(req)` untouched. `buildRoutes` passes a `Response` straight through, so
`Set-Cookie` and redirects survive.

The controller is a **subclass** created in `forRoot` — `Controller(basePath)(class
MountedAuthHandler extends AuthHandler {})` — rather than `@Controller` on the shared
class, because the prefix is only known once the module is configured. `discoverRoutes`
walks the prototype chain and `prefixOf` is a plain lookup, so the subclass inherits
the routes and contributes only the prefix.

`AuthHandler` is `@Public()` at class scope. Without it a globally installed
`SessionGuard` would demand a session from the sign-in endpoint, and no session could
ever be created.

### `basePath` and `mountAt` are two strings for one URL

better-auth resolves an endpoint by comparing the **whole pathname** to its own
`basePath` — measured: `baseURL: 'http://host/api'` with `basePath: '/auth'` serving at
`/api/auth/*` answers 404 to everything, so the path in `baseURL` is not consulted.

That collides with `setGlobalPrefix`, which rewrites every discovered route. With
prefix `api` the route has to be `/auth` while better-auth has to be told
`/api/auth`. `AuthModule`'s optional second argument is therefore the **route** path,
and `AuthOptions` carries both. Two knobs, but each has one meaning, and the common
case (no prefix) uses neither.

Both mistakes are caught rather than left silent. An async factory that returns a
non-default `basePath` without a `mountAt` fails at boot. A wrong explicit `mountAt`
cannot be known at boot — the global prefix is applied at `listen()` — so
`AuthHandler` checks the pathname against `basePath` on the **first** request only and
throws an `AuthError` naming both, instead of letting better-auth 404 silently.

### The principal travels in a second async store

`AuthContext` owns an `AsyncLocalStorage<Principal>`; `SessionGuard` runs `next()`
inside it. Two alternatives were rejected: request-scoped DI was measured and turned
down (see **Rejected**), and attaching the principal to `req` reaches a route handler
but nothing a route handler calls — which is the case that matters, since the caller is
usually wanted three constructor hops down.

It is deliberately **not** a key in `@dunx/core`'s `RequestContext`. That store is the
log record: every field in it is serialized into every line the request writes, so a
session object there would be noise on each entry and a redaction hazard in the ones
that matter. `userId` does go there — a well-known `RequestFields` key — which is why
every log line inside a guarded request is already correlated to the user.

### `@Public()` skips the guard outright

The alternative considered was resolving the session best-effort on a public route, so
`AuthContext.current()` would work there. It was dropped: the mounted auth endpoints
are all `@Public()`, so it would have put a duplicate session lookup on the busiest
public path in the app, `get-session` included. A public route that wants an optional
caller calls `auth.api.getSession({ headers: req.headers })` — one line, explicit, and
it costs nothing anywhere else.

### `Bun.password` replaces better-auth's scrypt

better-auth's default hasher is a **pure-JavaScript scrypt**; `AuthModule` substitutes
native bcrypt through `Bun.password` whenever `emailAndPassword` is enabled and no
`password` was supplied. Rule 1's first half, and it is what
`nestjs-template/src/auth/auth.config.ts` already does. Bun pre-hashes the input, so
bcrypt's 72-byte cap is a non-issue even for a maximum-length multibyte password, and
`verify` swallows Bun's `UnsupportedAlgorithm` throw so a hash from another algorithm
is a clean 401 rather than a 500. The cost is recorded in the README: an existing
scrypt-hashed user table needs password resets, or its own `password` implementation.

### `redisStorage` implements the atomic pair the reference could not

better-auth's `secondaryStorage` marks `getAndDelete` and `increment` optional because
most clients cannot do them atomically. `Bun.RedisClient` can, through `GETDEL` and
`INCR`, both already on `@dunx/infra/redis`'s contract — so all five methods are
implemented rather than the three that are mandatory. Without them better-auth falls
back to read-then-delete for single-use credentials, which is a race, and to a
non-atomic rate-limit counter. `increment`'s TTL is applied only when `INCR` returns
`1`, which is what makes the window fixed rather than sliding.

Redis being unreachable is deliberately not softened: a swallowed `null` from `get`
reads as "no session" and would sign every user out.

### No schema, on purpose

The four better-auth tables are better-auth's, they change with the plugins an app
enables, and its own CLI generates them (`bunx @better-auth/cli generate`). A copy
inside dunx is a copy that rots against the library that reads it. `examples/full` has
a generated one at `src/database/auth.schema.ts`, re-exported into the app's single
schema object — which is all `drizzleDatabase(connection)` needs, because
`@dunx/infra/db` builds its handle with `drizzle({ client, schema })` and the adapter
reads `db._.fullSchema`.

Two findings from building that fixture, both worth remembering: `db.run(sql\`…\`)`goes through`bun:sqlite`'s `prepare`, which compiles **one** statement and silently
drops what follows the first semicolon — four `CREATE TABLE`s in one template gives
one table. And better-auth rejects a cookie-bearing state change with no `Origin`
header (`MISSING_OR_NULL_ORIGIN`), so a server-side client has to send one matching
`trustedOrigins`; a browser does it for free.

## Multi-node websocket fan-out (`@dunx/http`)

`PubSub.publish` is `server.publish`, which is Bun's own pub/sub and therefore
per-process. Two nodes behind a load balancer each fan out to their own sockets and
to nobody else's. The fix is a relay: publish locally **and** hand the message to
the other nodes, which then publish locally too.

### The contract is two methods, and it lives in `@dunx/http`

```ts
interface PubSubRelay {
  publish(channel: string, message: string): unknown;
  subscribe(channel: string, listener: (message: string) => void): unknown;
  close?(): unknown;
}
```

Default: nothing. With no relay configured `PubSub` is byte-for-byte the code it was
before — one `server.publish` call and no branch that costs anything measurable.

The Redis-backed implementation, `RedisRelay`, uses **`Bun.RedisClient` directly**.
It is a Bun global, so this adds **zero dependencies** to `@dunx/http`, which still
depends only on `@dunx/core`.

**The rejected alternative was putting it in `@dunx/infra/redis`**, where the
connection handling, retry policy and error classification already exist. It was
rejected on the dependency direction: the relay has to be reachable from `PubSub`,
`PubSub` is `@dunx/http`, and `@dunx/infra` must not depend on the web layer. That
coupling has now been refused three times — for the request logger, for `@dunx/auth`,
and here — for the same reason each time: `@dunx/infra` is what a CLI script, a
seeder or a queue worker imports, and none of those have an HTTP server.

The cost accepted is a small amount of **relay-specific connection glue** that does
not reuse `@dunx/infra/redis`'s general-purpose client: URL validation, the
`maxRetries` default, lazy client creation, and unsubscribe-before-close. That is
about 60 lines, and it buys a package with one dependency.

An app that would rather reuse its existing connections satisfies the two methods
itself — and `@dunx/infra`'s `RedisConnection` **already does, structurally**:
`publish(channel, message)` and `subscribe(channel, listener)` are its own names and
shapes, so `app.get(PubSub).relayThrough(app.get(RedisConnection))` typechecks with
no adapter between them. That is the `@dunx/auth` `RedisStore` precedent — declare
the shape, let the app supply anything that fits — and `examples/full` runs its
second node that way on purpose.

### One channel, because `psubscribe` does not work

Frames for **every** topic travel on one broker channel, not one channel per topic.
Two reasons, both forced:

- A node cannot know which topics its sockets joined. `socket.subscribe(topic)` goes
  straight into Bun, and there is no hook and no way to enumerate it — so
  subscribing to a Redis channel when a topic gains its first local member is not
  implementable.
- `psubscribe` is unusable on Bun 1.3.14 (see [bun-apis.md](./bun-apis.md)), so a
  wildcard subscription is not available either.

The cost is that every node reads every relayed frame and drops the ones for topics
it has no local subscriber on — a `server.publish` returning `0`. Two apps sharing
one Redis need two channels, which is what `relayChannel` is for.

### Duplicate delivery is the failure mode, and an origin id is the defence

Redis delivers a published message to **every** subscriber of the channel, the
publishing application included — a relay's own subscribe connection receives what
its publish connection just sent. Fanning that out locally a second time would
deliver twice to every client on the publishing node, which is worse than not having
the feature.

So every frame carries the publishing process's id (`Bun.randomUUIDv7`, once per
`PubSub` instance) and the inbound path drops a frame whose origin is its own. The
other half of the rule is that the inbound path calls `server.publish` and
**nothing else** — re-relaying there would put the frame back on the channel that
delivered it, forever.

`relayThrough` throws on a second call rather than replacing the relay: two
subscriptions on one channel is the other way to get every message twice.

The guard is a test that asserts **exactly one** delivery per subscriber with
relaying on — `packages/http/src/ws/relay.test.ts`, once over an in-memory bus and
once over real Redis with two `Bun.serve` instances and a client on each. Both fail
with two frames if the origin check is removed, which was verified by removing it.

### Two connections, and why `maxRetries` defaults to 0

A `Bun.RedisClient` in subscriber mode rejects every data command and throws
synchronously doing it, so the subscription cannot share the socket that publishes.
`RedisRelay` opens two, lazily — the same `pubClient`/`subClient` split
`nestjs-template`'s socket.io adapter makes.

`maxRetries` defaults to `0` because a client that never connects keeps a retry
timer alive past `close()` and **the process then never exits**. A relay is exactly
the connection most likely to be absent, so the default has to be the one that lets
an app boot, degrade and still exit. Raising it opts into Bun's reconnection and
accepts that hazard.

`maxRetries: 0` is not sufficient on its own, and finding out cost real time. Two
further `Bun.RedisClient` behaviours hold the event loop open past `close()`, and the
symptom of both is a service that shut down cleanly and then hangs forever:

- a client that **entered** subscriber mode — fixed by `unsubscribe()` before
  `close()`;
- a `subscribe()` that **failed to connect** — fixed by `connect()` before
  `subscribe()`, which fails first and releases cleanly. `unsubscribe()` cannot
  rescue this one, because the client is not in subscriber mode.

Both were already latent in `@dunx/infra/redis` and are fixed there too. The
measurements are in [bun-apis.md](./bun-apis.md). The guards have to be **spawn-based
tests**: `bun test` exits the runner process itself, so a held-open event loop is
invisible from inside the suite — which is exactly why this survived until an example
app tried to shut down.

Absence is tolerated at every step: a failed subscribe reports once and leaves local
fan-out untouched; a failed publish reports once and not again until one succeeds;
the app boots either way. A malformed **URL**, by contrast, throws at construction —
that is a config bug, and degrading silently would turn a typo into single-node
fan-out nobody notices.

### What the relay does not cover

`socket.publish(topic, data)` is Bun's own method on the socket and does not go
through `PubSub`, so it stays local. Anything that must cross nodes goes through
`PubSub`. `subscriberCount` is local too — Bun counts its own sockets and cannot
count another node's.

## Queues (`@dunx/infra/queue`)

**bullmq is the queue.** Rule 1's second half applied again: retries, backoff,
priorities, rate limiting, delayed jobs, schedulers and stall recovery are bullmq's,
and a dunx implementation of any of them would be a worse one. `bullmq` is an
optional `peerDependency`. What the area contributes is the four things bullmq has
no opinion about — where a handler lives, how it is found, how it is injected, and
when it stops.

### The ioredis boundary, as it actually resolved

CLAUDE.md's "Where the two halves collide" anticipated ioredis arriving as bullmq's
internal engine and sanctioned it on the grounds that the ban is on _dunx_
reimplementing a Bun primitive. The measurement changed the answer for the better:

**bullmq 6 ships `createBunRedisClient`, an `IRedisClient` adapter over
`Bun.RedisClient`.** bullmq accepts either a connection description it builds a
client from, or an already-built client implementing that interface — so
`QueueConnection` builds `Bun.RedisClient` instances and hands them over wrapped.
Every byte of queue traffic goes through Bun's client. dunx neither imports nor
constructs ioredis, and there is no shared socket with `@dunx/infra/redis`: a queue
gets one client per bullmq object, because a `Worker` blocks on `BZPOPMIN` and bullmq
duplicates whatever it is given to get a connection it may block on.

Verified on bullmq 6.0.5 + Bun 1.3.14 + Redis 8.4.0, over that adapter, in 0.5 s:
concurrency 5 honoured across 20 jobs, `attempts: 2` with fixed backoff retrying a
throwing handler exactly once, a delayed job reporting state `delayed` and arriving,
and `worker.close()` waiting 244 ms for a 250 ms handler rather than dropping it.

Three findings that shaped the code:

- **ioredis is a load-time requirement of bullmq's barrel.** `classes/index` exports
  `redis-connection`, which statically imports `ioredis` and `ioredis/built/utils`,
  so `import { Queue } from 'bullmq'` throws `Cannot find module` without it —
  despite bullmq 6 declaring `ioredis` an _optional_ peer and shipping three other
  backends. So `ioredis` is listed as an optional peer of `@dunx/infra` as well:
  declaring it is how a consumer's install produces something that works, and
  nothing in dunx reaches for it. If bullmq makes that import lazy, the entry
  disappears.
- **bullmq does not close a connection it was handed.** Measured with `CLIENT LIST`:
  four connections live, three after `worker.close()` + `queue.close()` — it closed
  only the duplicate it created itself. `QueueConnection.onShutdown` closes the
  rest, and is bound as the first-constructed provider so reverse-order teardown
  runs it last.
- **Closing one afterwards emits `error` on an emitter with no listener**, because
  bullmq detaches its own handler on close and Node's `EventEmitter` throws for an
  unhandled `error`. Shutdown would fail on its last step. The adapter gets a no-op
  `error` listener at construction.

`@dunx/infra/queue` is deliberately **not re-exported from the package barrel**,
unlike every other area. `src/index.ts` re-exporting it would put bullmq's static
`ioredis` import behind `import '@dunx/infra'` for every consumer, queue or no
queue. The subpath is the only way in.

### Job discovery

The **marker-plus-prototype-scan** technique from **Route discovery**, third use:
`@JobHandler({ queue, name })` sets a symbol property on the method function it
receives and returns it. Nothing accumulates at class-definition time, so there is no
ordering dependence and no cross-file leak. `WorkerFactory` walks
`Object.getPrototypeOf` from the prototype of each class the modules already declare
in `providers`/`controllers`, exactly as `discoverGateways` does.

What that buys, and it is the same list routes get: no second registration key, no
`@Processor` class decorator, an abstract base's handlers inherited by every
subclass, an undecorated override still dispatched to because the handler is bound
off the instance, and a duplicate `(queue, name)` as a boot error naming both
methods rather than traffic silently split between them.

One asymmetry with gateways is deliberate. `discoverGateways` throws when a class
declares a handler but is not marked `@Gateway`, because such a handler could never
receive a frame. There is no class-level marker here, so there is no such orphan
state and no such error.

A factory- or value-provided instance is **not** scanned. There is no class to read a
prototype chain from until it has been built, and building every factory provider to
find out whether it was worth building is the ordering trap the marker technique
exists to avoid.

### Publish and consume are different processes, so they are different objects

`QueueModule.forRoot()` binds the **publish** side only — `QueueOptions`,
`QueueConnection`, `JobPublisher` — so a web process importing it opens no worker.
`WorkerFactory.create(root)` is the consume side, and it is the same shape as
`HttpFactory.create`: boot the container, `collectModules(root)` for the graph,
discover by inspection, validate eagerly, and return an object wrapping `App` whose
`shutdown()` sequences its own resource ahead of the container's.

`create` discovers and validates; `start()` opens connections. That split is what
makes a wiring mistake — no `QueueModule`, no handlers, a misspelled name in
`queues` — fail before anything consumes, and what lets `worker.jobs` be asserted in
a test with no server running.

The "no `QueueModule`" check reads the **module graph**, not the container, and the
reason generalises past queues: **every class self-binds, so a class whose
constructor arguments are all optional resolves successfully when nothing bound it.**
`app.get(QueueOptions)` on a container with no `QueueModule` returns defaults — a
worker silently pointed at `localhost` — rather than throwing. Any presence check for
a class-shaped token has the same hole; `collectModules(root)` and a token comparison
do not.

`JobPublisher` returns bullmq's own `Queue` and `Job` rather than wrappers, for the
same reason `/db` returns drizzle's database class: the library is the interface, and
a wrapper would be a surface to outgrow.

### The one behaviour that is dunx's, not bullmq's

`jobTimeoutMs`. bullmq has `lockDuration` and stall detection, which answer _did the
worker die_, not _is this handler stuck_ — a handler hung on an external call renews
its lock and never finishes. The dispatcher races the handler against a timer and
clears it in a `finally`, since an uncleared timer would hold the loop open for its
full duration after a fast job. Off by default.

### Shutdown ordering

`WorkerApplication.shutdown()` closes every bullmq `Worker` first, then delegates to
`app.shutdown()` — the same reason `HttpApplication` stops the server before the
providers tear down. `close()` without `force` stops fetching and waits for what is
already running, so an in-flight handler finishes while the database connection it is
using is still open. The container's reverse-construction-order teardown then closes
the publisher's queues and finally `QueueConnection`'s sockets.

The integration suite asserts that order rather than just the outcome: a provider
injected into the handler records `container:shutdown` in its `onShutdown`, and the
test requires the sequence `slow:started`, `slow:finished`, `container:shutdown`,
plus zero open sockets afterwards.

## Test harness (`@dunx/testing`)

The override semantics are specified under "Modules group registrations" above and
were not redesigned. What follows is the decisions that specification did not
cover.

**The substitution lives in `@dunx/core`, as `AppFactory.create(root, { overrides })`.**
`createTestApp` cannot assemble the flat list itself: `Injector` and `readModule`
are deliberately not exported, because exporting the container would freeze its
shape as public API, and a testing package that duplicated the register-resolve-
`onInit` loop would be a second container to keep in step with the first. So core
grew the seam and `@dunx/testing` is a thin wrapper over it — `substitute()` is
fifteen lines on the path that was already assembling the list, and costs an empty
`Map` lookup per registration when no overrides are passed.

The seam is `readonly Registration[]`, not a test-shaped API: it is "compose this
graph with these bindings replaced", which is also how a deployment variant would
be expressed. `HttpOptions extends AppOptions`, so the HTTP factory inherits it
without a second mechanism.

**The always-bound defaults are substituted too.** `Logger` and `RequestContext`
are offered by `registerDefault` after every module, so nothing in the module graph
binds them in a typical app — and an override of `Logger` would therefore have been
"nothing to override". They are now built as a `Registration[]` and run through the
same substitution, which is what makes silencing the logger in a test possible at
all. The unmatched-override check runs after both stages.

**`requestLogging` defaults to `false` in `createTestServer` only.** The framework
default stays on. A suite is the one context where one structured line per request
is pure noise, and the alternative — every suite passing `requestLogging: false` —
is a default in the wrong place. Asserting on request logging means asking for it.

**`@dunx/core` and `@dunx/http` are `dependencies` at `workspace:^` — measured, not
assumed.** Peers were the first choice and are the better contract: a second copy of
core in a consumer's tree is a second `Logger` class and therefore a token that
matches nothing, so overrides would silently replace nothing — exactly the failure
the unmatched-override error exists to prevent. It does not survive the build.

`bun run --filter '*' build` derives its ordering from **`dependencies` only**.
Measured on Bun 1.3.14: with core in `devDependencies` and in `peerDependencies`
(both tried, including a `workspace:` range in the peer field), `@dunx/testing`'s
`tsc` ran concurrently with core's own build and failed with `TS7016: Could not find
a declaration file for module '@dunx/core'` — `build-package.ts` deletes `dist/`
before writing it. In CI, where no `dist` exists at all, that is not a race but a
certainty.

Two consequences worth keeping:

- The range is `workspace:^`, not the `workspace:*` every other package uses.
  `scripts/version.ts` publishes `workspace:*` as the **exact** version, so
  `@dunx/testing@0.4.0` would demand `@dunx/core@0.4.0` and a consumer on 0.4.1
  would get a nested second copy — the duplication being avoided. `workspace:^`
  publishes as `^0.4.0`, which hoists across patches. The same hazard exists in the
  other packages' `workspace:*` dependencies and deserves its own pass.

  While dunx is pre-1.0 this is a partial fix, not a complete one: `^0.4.0` is
  `>=0.4.0 <0.5.0`, and `version.ts` only republishes packages whose own `src`
  changed. A core-only **minor** bump therefore leaves a published
  `@dunx/testing` pointing at the previous minor, and the nested copy returns. Until
  core reaches `1.x`, a minor bump of `@dunx/core` or `@dunx/http` wants
  `@dunx/testing` republished with it.

- **A published package's tests cannot import a workspace package that is not one of
  its runtime dependencies.** The first draft converted
  `packages/openapi/src/module.test.ts` to the harness. A package's build typechecks
  its own tests, so that made openapi's build race `@dunx/testing`'s, and putting
  `@dunx/testing` in openapi's `dependencies` would ship a test package to
  production. Reverted. `examples/*` have no such limit — nothing builds in parallel
  with them — which is why `examples/full/src/service.test.ts` is where the
  harness is exercised against a real app.

`@dunx/http` is therefore not optional, and `createTestServer` imports it normally.

**No `providers` key on the options.** `{ modules, overrides }` is the documented
shape and stays that shape. A `providers` list would make the harness able to
assemble graphs that do not exist in the app, which is how a suite ends up
asserting against a container the production app never builds. A fixture class that
needs binding goes in a two-line `@Module` — where it would live if it were real.

**Two request helpers, no assertion DSL.** `json()` returns `{ status, headers, body }`
and `request()` returns the `Response`. A JSON body is `json:` on the init object
rather than a `post`/`put`/`patch` triple, so every verb is one call shape.
`json()` reads text before parsing so a 204, an HTML error page or a plain-text
body fails with the status and content-type rather than with `JSON.parse`'s
message. `RecordingLogger` is the one other helper, earned by the contract being
seven levels of three overloads: it records and interprets nothing.

**`prefix` is `string | undefined` where every other option is not.** A suite that
runs one fixture prefixed and unprefixed passes a variable, and under
`exactOptionalPropertyTypes` that is otherwise a conditional spread at the call
site. "No prefix" and "absent" are the same state here, so nothing is lost — this
is not a licence to widen options where they differ.

## Versioning is lockstep, and that is a correctness requirement

Every `@dunx/*` package shares one version and is published together, even when a
release touches only one of them. Change detection decides _whether_ to release,
never _what_.

This is not tidiness. `scripts/version.ts` rewrites a `workspace:*` range to the
dependency's **exact** version when it packs a tarball, because `npm publish` leaves
the `workspace:` protocol untouched. With independent versions that produces:

```
@dunx/http@0.2.0   ->  "@dunx/core": "0.1.0"
@dunx/infra@0.3.0  ->  "@dunx/core": "0.2.0"
```

An app installing both gets **two copies of `@dunx/core`**. In this container a
token _is_ a class object — `provide(Logger, …)` keys a `Map` by the class itself —
so two copies means two distinct `Logger` classes, and `app.get(Logger)` misses the
binding another package registered. It fails silently, at boot, with a message
about a missing provider for a token the user can plainly see is bound.

`Symbol.for('dunx.deps')` was already chosen so duplicate copies of core still agree
on the deps key. Class identity cannot be made to agree, so the duplicate has to be
prevented instead.

Two alternatives were considered and rejected:

- **Caret ranges.** Pre-1.0 `^0.1.0` excludes `0.2.0`, so a minor bump of core still
  fragments the graph. `^` only helps within a patch series.
- **`@dunx/core` as a `peerDependency`.** This is the textbook answer — peers resolve
  to one copy — and it was **measured, not assumed**: `bun run --filter '*' build`
  orders builds by `dependencies` alone, so moving core to a peer races `tsc` in
  `@dunx/http` against core's own `.d.ts` emit, and the build fails with
  `TS7016: Could not find a declaration file for module '@dunx/core'`. Adopting peers
  means replacing the filter-based build with a topological one first. Worth doing
  eventually; it is not a prerequisite for shipping.

The cost of lockstep is that an untouched package still takes a version. For a
pre-1.0 framework whose packages move together anyway that is a feature: one number
answers "which versions work together", which is the question a consumer of six
packages actually has.

## The API explorer (`tools/openapi-ui`)

`@dunx/openapi`'s page was hand-written HTML inside a backend package: a `<style>`
block, `<details>` for the folding and ~90 lines of inlined DOM code. It had no
auth handling, no disclosure affordance and printed schemas as
`JSON.stringify(…, null, 2)`. Growing it further was the wrong direction, so the
UI is now a frontend workspace whose built bundle the package serves.

### The bundle is inlined, and that is what constrains everything

The page's guarantee is that it fetches **nothing** — no CDN, no `src=`, no
`<link>`. `swagger-ui-dist` (11.7 MB unpacked) and `@scalar/api-reference` (11 MB)
were rejected over exactly that, and the guarantee did not get cheaper because the
UI got better. So the bundle is a string in `packages/openapi/src/ui-bundle.ts`,
written by `tools/openapi-ui/scripts/build.ts` and interpolated into one
`<script>`. `</` is escaped at build time, not per request.

`ui-bundle.ts` is **generated and committed**. `bun test ./packages` at the root
and `tsc --noEmit` in a fresh clone both have to work without a Vite run, and the
publish path must not depend on one. `packages/openapi`'s `build` runs the UI
build first, so the committed copy cannot go stale.

### What it costs — measured

| Build                                     | Raw         | gzip        |
| ----------------------------------------- | ----------- | ----------- |
| react + react-dom, nothing else           | 188 KiB     | 60 KiB      |
| + Mantine, `styles.css` barrel            | 517 KiB     | 128 KiB     |
| + Mantine, per-component CSS              | 381 KiB     | 110 KiB     |
| **shipped** (the explorer, per-component) | **437 KiB** | **123 KiB** |

The served page went from **70 KiB to 458 KiB** (6.5x; 6.6 KiB to ~125 KiB
gzipped). React is 188 KiB of it and is the floor — Mantine adds ~150 KiB of JS
and ~80 KiB of CSS on top.

Two decisions came out of measuring rather than guessing:

- **Per-component CSS, not the barrel.** `@mantine/core/styles.css` is 234 KiB for
  a dozen components; importing `styles/Accordion.css` and friends is a third of
  that. The list in `src/styles.ts` is load-bearing — a missing file is an
  unstyled component, not a build error.
- **`Tooltip` and `ScrollArea` were dropped** for `title=` and `overflow: auto`,
  which took 490 KiB to 437 KiB. `Tooltip` drags in floating-ui.

**This is the one number worth revisiting.** 437 KiB inlined is ~3x smaller than
swagger-ui's own bundle and normal for a modern web app, but it is 6.5x the page
it replaced, and it lands in a package that otherwise ships ~40 KiB with zero
runtime dependencies. If that trade stops being worth it, the lever is the
rendering layer, not Mantine: `preact/compat` would remove ~170 KiB, at the cost
of running Mantine on a compatibility shim.

### Vite here, `bun build` in `tools/docs`

The docs site measured Vite at 1.7 s against `bun build ./index.html` at 41 ms and
took Bun's ~25 % larger output, which is right for a site. Every byte here is
inlined into a page a backend serves, so Rollup's tree-shaking wins and the ~1.8 s
is paid once per package build.

### Markdown and samples stay on the server

`Bun.markdown.html` renders every description and `sampleFor` pre-computes every
request body, both in `packages/openapi/src/model.ts`; the results travel in the
model. Rendering markdown in the browser would have meant a parser in the bundle,
and re-implementing `sampleFor` would have meant two of it. This is also what
keeps the raw-HTML escaping (`noHtmlBlocks`, `noHtmlSpans`, `tagFilter`) in one
place — the client only ever sees already-escaped HTML.

### The no-external-requests test had to change shape

`expect(page).not.toContain('src=')` was sound over hand-written HTML and is
meaningless over a minified React bundle, which contains `.src=`, `href="` and the
literal string `"<script>"` in its own code. The assertion moved to the **tags**:
the page is stripped of both script bodies, and the remaining markup must carry no
`src=`, no `<link>` and no off-origin `href`. The whole page is still checked for
`url(http`, `@import` and CDN hosts. `page-ui.test.ts` then proves it positively —
it runs the real bundle in happy-dom and asserts zero fetches during boot.

## Benchmark harness (`tools/bench`)

Full methodology, subject list and results table:
[`tools/bench/README.md`](../tools/bench/README.md). Recorded here are the decisions
and the measurements behind them.

**The first thing the harness found was a regression dunx had shipped to itself.**
`@dunx/http` had just made `RequestLoggingMiddleware` a default, and the bench
subject predated it, so the suite was quietly measuring the logger. dunx fell from
~86-94% of raw `Bun.serve` to **34% on `json`, 33% on `params` and 9.6% on
`validate`** — 8.5k req/s against 88k, a p50 of 7.4 ms. Setting
`requestLogging: false` restored ~89%, which located the fault precisely.

Three causes, in order of cost:

- **`response.clone().text()` on every JSON response**, and `req.clone().text()` on
  every JSON request body. Two clone-and-buffer passes over every payload, on the
  hot path, to fill fields most responses never need read. Both are now **off by
  default** — which is the right default for privacy and log volume independently of
  speed, since the response body is also the field most likely to carry a secret.
- **`new URL(req.url)` per request**, parsing scheme, host, port, query and hash to
  reach a pathname. Replaced with an `indexOf` slice; the query string is parsed
  only when there is one.
- What remains is `JSON.stringify` plus a `write` per line, which is the irreducible
  price of logging and is why `dunx-logging` is its own subject rather than folded
  into the framework's number.

**The rest of the gap to Elysia was async machinery on values that were never
promises.** The general request path is
`async (req) => toResponse(await handler(await read(req)), status)` wrapped in an
`async` try/catch. For a route with no middleware, no CORS and no declared schemas,
`read` is the identity reader and a sync handler returns a plain object — so both
`await`s cost an async frame and a microtask tick for nothing, twice per request.

`buildRoutes` now emits a **synchronous handler** for exactly that shape, returning a
`Response` rather than a `Promise<Response>` (Bun accepts either). A handler that
does return a promise is adopted instead of awaited by a wrapper. Measured on
`plaintext`: **89.5% -> 97.2%** of raw `Bun.serve`, which puts dunx within 0.8
points of Elysia there and within 1.5 points on every scenario. Elysia's advantage was that it
compiles this shape ahead of time; this reaches most of the same place without a
code generator.

The lesson worth keeping: a default that is convenient in development can be the
single largest cost in production, and nobody would have known without a harness
that compares against the floor. `Bun.serve` as a subject is what made the
regression legible — a 9.6% row is impossible to rationalise.

**The load generator is native, and that was measured rather than assumed.** The
harness supports two: [oha](https://github.com/hatoo/oha) (Rust, via `bun run
setup`) and a fallback driver written on Bun's `fetch` across worker threads. Against
the same raw `Bun.serve` process at 64 connections, oha extracts **135k req/s** and
the JavaScript driver plateaus at **80k**, collapsing to **23k** at 256 connections
as thirty worker threads contend on Bun's connection pool. The JS driver would have
understated every Bun subject by roughly 40% and compressed the whole ranking. This
is Rule 1's "native, not a JavaScript reimplementation" holding in a place where it
is easy to check: `oxc-parser` over a JS AST library is the same call.

**oha has headroom over the fastest subject, and that was checked too.** One
`Bun.serve` process driven by one oha gives ~130k req/s; four `Bun.serve` processes
driven by four oha instances give **~385k req/s in total**. A generator with 3x
headroom is not what the numbers are measuring. Without this check the whole table
would be unfalsifiable.

**`bombardier` and `wrk` are deliberately unsupported.** Each is one adapter next to
`src/loadgen/oha.ts`, but an untested output parser producing plausible-looking wrong
numbers is worse than an honest "not supported".

**The `Bun.serve` baseline uses route handlers, not static `Response` objects.**
`Bun.serve({ routes })` accepts a `Response` instance and serves it from a
precomputed buffer, which beats any framework for reasons unrelated to frameworks.
Using it would have inflated the ceiling `@dunx/http` is measured against.

**Every subject validates with the same zod schema**, including Fastify and Elysia,
which ship faster compiled validators. Holding the validator constant is what makes
`validate` minus `json` readable as one framework's validation plumbing. It
understates Fastify and Elysia, and the JSON report records each subject's validator
so the handicap is visible rather than implied.

**Latency histograms, not reservoir sampling.** The fallback driver buckets latencies
at 1 µs up to 100 ms and merges `Uint32Array`s across workers. The alternative —
sampling a subset — needs an RNG, and a sampled p99 is a p99 with an error bar nobody
reads. It also keeps `Math.random` out of a number that matters, per the `@arkv/rng`
rule.

What the harness found, in one line each:

- `@dunx/http` costs **6–7%** against raw `Bun.serve` on plain dispatch and JSON,
  **14%** with a path parameter, **21%** with body validation.
- It **loses to Elysia on all four scenarios**; the `params` gap (85.8% vs 95.5% of
  baseline) is the largest and is the clearest optimisation target. Elysia compiles
  per-route handler code ahead of time.
- It **boots in ~53 ms against raw `Bun.serve`'s ~27 ms** — the compiler's oxc parse
  plus eager DI resolution and route discovery. That is the trade this architecture
  makes on purpose: paid once at boot, never per request. It is a real cost on a
  short-lived process.
- **Bun is worth ~2.3x on its own.** The same Hono app scores 101,667 req/s on
  `Bun.serve` and 43,706 on `node:http`, a larger gap than any two frameworks on the
  same runtime.

## The cost of request validation (`tools/bench` validation harness)

`bun run validation` in `tools/bench` is a second harness, separate from
`bun run start`, because the main suite deliberately cannot answer two questions: it
holds the validator constant at zod so `validate` minus `json` reads as one
framework's plumbing, which folds **the absolute cost of parsing and validating**
together with **dunx's own overhead**. This one separates them. `servers/validation/`
has two subjects — raw `Bun.serve` and a dunx app — each serving routes that add one
step at a time, and `$VALIDATOR` swaps the library behind `~standard` without
changing anything else.

**The first version of this harness measured each row to completion in turn, and that
was wrong.** The differences it exists to report are 2-4%, and the machine's own
throughput drifts by more than that over the minutes a run takes — so the drift landed
on whichever row happened to be measured while it was happening. It produced
`raw:parse` as _slower_ than `raw:noop`, which does strictly more work, and several
negative validator costs. The runner now brings every unit up first and measures them
**round-robin**, which spreads the drift across all rows equally; the ordering came out
monotonic on the first attempt afterwards. Noise floor at this throughput is about
**±0.3 µs**, and figures below it are reported rather than clamped.

### Parsing costs 3x what validating costs

| Step                                     | µs/req | adds     |
| ---------------------------------------- | -----: | -------- |
| `GET /json`, no request body             |   8.78 | —        |
| `POST`, body on the wire, **never read** |   9.05 | +0.27 µs |
| `POST` + `await req.json()`              |  12.14 | +3.10 µs |
| `POST` + `req.json()` + zod              |  13.09 | +0.94 µs |

Putting a body on the wire is near-free; reading it is 3.10 µs and validating it is
0.94 µs. The ~30% drop from the `json` scenario to the `validate` scenario that every
subject in the main suite pays is therefore **77% `req.json()` and 23% zod**. The
primitive that would fix it is a validating parser Bun does not ship — recorded in
[bun-apis.md](./bun-apis.md), along with why dunx must not write one.

### Every validator is cheaper than the parse

The same dunx app, the same schema shape, only the library behind `~standard`
changed. Cost is that validator's own time, taken as the raw `Bun.serve` subject's
µs/req above the `req.json()`-only row:

| Validator                   |    costs | `~standard` |
| --------------------------- | -------: | ----------- |
| TypeBox, `TypeCompiler` AOT | −0.01 µs | bridged     |
| ajv, compiled JSON Schema   |  0.34 µs | bridged     |
| ArkType                     |  0.42 µs | native      |
| Valibot                     |  0.89 µs | native      |
| zod                         |  0.94 µs | native      |

**zod, Valibot and ArkType are within noise of each other**, and both compiled options
land at or under the noise floor — TypeBox's compiled checker is indistinguishable
from not validating at all on a three-field payload. All five are under the 3.10 µs
the parse costs, so **there is no throughput argument for steering a user off zod**: a
0.9 µs saving on a request that takes 13 µs is 7%, against giving up zod's ecosystem,
error messages and `z.toJSONSchema` (which `@dunx/openapi` uses). The advice this
produces is "pick on API, not on this table", and the table exists so that advice is
checkable. It would very likely read differently on a deeply nested schema, where
compiled straight-line code diverges from an interpreter far more than at this size —
which is a limitation of the payload, and is recorded in the harness's README.

Neither TypeBox 0.34 nor ajv 8 exposes `~standard`. Both were bridged in about ten
lines each in `servers/validation/schemas.ts` — a boolean `Check` plus their error
iterator, wrapped in a `~standard.validate`. That a compiled JSON Schema checker
drops into a dunx route with no change to `@dunx/http` is the payoff of targeting an
interface instead of a library, and it is worth knowing it was tested rather than
assumed. Valibot and ArkType need no bridge; ArkType's `ArkErrors` is an `Array`
subclass with an `issues` getter, which the existing code already handles.

### Where dunx's 11 points went: async machinery, not validation

The main suite's `validate` row sat at **84.0% of raw `Bun.serve`** while `json` sat
at 95.3%. Splitting dunx's side the same way — two extra dunx routes that declare no
schemas and do the parse and the validation inside the handler, so they stay on the
synchronous dispatch path — located it. Measured **before** the changes below:

| Subject                                       | µs/req | dunx's share        |
| --------------------------------------------- | -----: | ------------------- |
| raw `Bun.serve`, parse in the handler         |  11.89 | —                   |
| dunx, no schemas, parse in the handler        |  13.06 | 1.17 µs dispatch    |
| dunx, no schemas, validate in the handler     |  14.56 | + zod               |
| dunx, `body` declared — the framework does it |  16.62 | **+2.05 µs reader** |

**The input reader cost 2.05 µs — nearly twice what zod itself cost.** An in-process
microbenchmark against a fake request (so no real parse is involved) put the reader's
plumbing at **597 ns/request with a no-op schema**, against ~250 ns for zod's actual
`validate` on the same payload.

The cause was async machinery on values that were never promises — the same fault the
`plaintext` fast path had, one layer down. A route with a declared `body` went through
six `async` frames: `guarded`, `chained`, the reader, the fold step, `readBody`, and
`validated`. Exactly one of them, `req.json()`, ever had anything to wait for.
Standard Schema _permits_ `~standard.validate` to return a promise, and none of zod,
Valibot or ArkType ever does — verified, all three return a plain object.

Three changes, each measured:

1. **`packages/http/src/server/input.ts`: nothing is `async` any more.** `Fill` is
   `(draft) => InputDraft | Promise<InputDraft>` and every step looks at what it got
   instead of awaiting it. A `query`- or `params`-only route with a synchronous
   validator now returns the input **with no promise at all**; a `body` route pays one
   promise link on `req.json()` instead of six frames. The `then` fold returns the
   draft rather than `void` precisely so the reader can be `(req) => fill({ req })` —
   threading the draft back through a second `then` cost a measurable 58 ns.
   `mediaTypeOf` also short-circuits on a verbatim `application/json` header rather
   than slicing, trimming and lowercasing it: worth ~70 ns when the header is bare.
2. **`packages/http/src/server/routes.ts`: the direct dispatch path now covers routes
   that read input.** It used to require `readsNothing`; the condition is now just "no
   middleware and no CORS", and `readsNothing` is gone because the general code
   collapses to it. `read`, the handler and the response coercion are each adopted
   rather than awaited.
3. **A `query` route stopped parsing the whole URL, and `grouped` stopped iterating.**
   `new URL(req.url).searchParams` resolved scheme, host, port, path and fragment to
   reach a query string, then built a `URLSearchParams` anyway — measured at **~1,040
   of the ~1,520 ns** a three-pair query route cost, which was more than the entire
   body reader. An `indexOf('?')` slice into `new URLSearchParams` removes the URL
   parse; the fragment is still stripped, because `new URL` stripped it and a
   request-target that carries one should not change what a schema sees.
   `RequestLoggingMiddleware` had taken exactly this slice for exactly this reason —
   the same fault twice, in two files, found the same way.

   `grouped` then switched from `for…of` destructuring to `forEach`, which both
   `URLSearchParams` and `FormData` implement natively: destructuring an iterator
   allocates a two-element array per entry, and dropping it was worth another ~140 ns.
   Together: **1,520 -> 1,024 ns**, a third of a query route's cost.

   What is left is `new URLSearchParams(search)` at ~624 ns, and it stays. Splitting
   on `&`/`=` and calling `decodeURIComponent` by hand would be faster and is exactly
   what Rule 1's first half forbids: a JavaScript reimplementation of a Web standard
   Bun implements natively, with `+`-versus-`%20`, repeated keys, empty values and
   malformed escapes to get wrong.

Measured one change at a time, as dunx's own overhead per request on the zod validate
route:

| Stage                     | dunx overhead | dunx vs raw |
| ------------------------- | ------------: | ----------: |
| before                    |       3.66 µs |       78.0% |
| after the reader change   |       2.64 µs |       83.0% |
| after the dispatch change |       1.40 µs |       90.3% |

In the main suite that is **`validate` 84.0% -> 92.3% of raw `Bun.serve`**, which also
puts dunx **9 points ahead of Elysia** on the one scenario where it used to be level
(Elysia is at 83.2% in the same run). The reader now costs _less_ than doing the same
work by hand in a handler — the "framework does it" row comes out 0.19 µs **below**
the hand-written one, inside the noise floor, which is the honest reading of "no longer
costs anything". The microbenchmark agrees and can resolve it: the reader's plumbing
went from **597 ns to 146 ns** with a no-op schema, a 4.1x improvement, and a
`params`-only route with a synchronous validator reads and validates in **56 ns** with
no promise allocated at all.

Nothing about the `json`, `params` or `plaintext` rows moved, which is the check that
changes 1 and 2 are confined to routes that declare a schema.

Change 3 has **no HTTP evidence at all**, and that is a gap rather than a detail:
neither harness has a route with a declared `query` schema — the main suite's `params`
scenario reads `input.req.params` with no schema, so it never touches the query path.
The 1,520 -> 1,024 ns is microbenchmark-only, and the right fix is a `query` scenario
in the harness rather than a larger claim here.

### Tried and rejected: a specialised single-schema reader

Most routes declare exactly one schema, so the fold and the shared `InputDraft` are
avoidable: a hand-written body-only reader that builds `{ req, body }` as one literal
and calls `~standard.validate` inline measured **306 ns/request against the shipped
reader's 394 ns** on the same microbenchmark — a real, repeatable 88 ns.

Rejected. 88 ns is 0.6% of a 14 µs request, which is **below the noise floor of the
HTTP harness** (run-to-run stddev is 1-3%), so the win cannot be demonstrated at the
level anyone experiences it — and unlike the `forEach` change above, which is a
comparable 140 ns, it does not pay for itself in simplicity. It would need one code
path per declared combination to be consistent, and would duplicate the 415 and 400
handling that `bodyFill` owns, where `forEach` replaced a `for…of` with fewer moving
parts than it had before. That asymmetry is the rule this file is applying: a
sub-noise-floor win is worth taking when the code gets simpler and not when it
does not.

Also rejected: pre-seeding the draft with the declared keys set to `undefined` so the
property stores do not transition the object's shape. It changes `Object.keys(input)`
for a route whose validator rejects, which is observable, for a fraction of the 88 ns
above.

### What still costs, and why it is not obviously fixable

dunx's remaining ~1.3 µs on this route is **dispatch, not validation**: a dunx route
whose handler does the parse itself still costs 1.17 µs over the identical raw
`Bun.serve` handler, and the input reader now adds almost nothing on top. That
residue is the closure indirection and the one extra promise link needed to adopt a
handler's return value. Removing it means generating per-route source and `eval`-ing
it, which is Elysia's approach; it would trade a readable dispatch path for a code
generator, and at 1.3 µs on a request whose parse alone is 2.9 µs it is not the next
thing worth doing.

## The cost of request logging (`tools/bench` logging harness)

`bun run logging` is the third harness, and it exists because `dunx-logging` in the
main suite was **one number for at least eight different things**. It sat at 40-45%
of raw `Bun.serve` while `dunx` sat at 90-98%, so dunx's _default_ configuration —
the one nearly every user runs — cost more than half the throughput, and nothing said
which half.

`servers/logging/dunx.ts` is one app whose middleware is truncated at a step chosen
by `$LOGGING_VARIANT`, plus three stand-in `Logger` bindings that stop after the
entry, after the timestamp, and after `JSON.stringify`. Rows are brought up together
and measured **round-robin**, for the reason the validation harness records.

Where `dunx-logging` ended up, as a fraction of raw `Bun.serve` in the same run:

| Scenario    | before | after |
| ----------- | -----: | ----: |
| `plaintext` |  41.7% | 55.7% |
| `json`      |  40.1% | 52.9% |
| `params`    |  39.5% | 54.5% |
| `validate`  |  48.1% | 63.1% |

**Two of those points are a harness fix and the rest are code, and the split is worth
being explicit about.** Measured as overhead over `requestLogging: false` on the
`json` route: the old code into `/dev/null` cost **+10.51 µs**; the new code
unbatched costs **+7.24 µs**; the new code as shipped costs **+5.38 µs**. So the
structural changes are worth ~3.3 µs and batching ~1.9 µs. Separately, the pipe the
harness never drained was worth 2.68 µs on top of that with an unbatched writer, and
that was never dunx's cost at all.

### The harness was measuring the pipe, not the framework

Before anything else: `startSubject` spawned every subject with `stdout: 'pipe'` and
**nothing ever read it**. 64 KiB in, the pipe is full, and the server parks on every
subsequent write until the kernel finds room. Seven of the eight subjects log
nothing, so only `dunx-logging` ever hit it — the one row where it mattered.

Measured, on the `json` scenario: an unbatched writer into an unread pipe cost
**2.68 µs/request** more than the same writer into `/dev/null`. Subjects now write to
`/dev/null` (`StdoutSink` in `src/subject-process.ts`), which is a real `write(2)`
that can never block, and the blocked-pipe case survives as an explicit row rather
than as the default. The docstring in `servers/dunx-logging.ts` claimed the harness
drained that pipe; it never did.

### Where the time went

Every row is the same app on the same `GET /json` route, one step further along the
default path than the row above it. Measured **after** the changes below; the noise
floor is about ±0.5 µs, so three of these steps are not resolvable at all.

| Step                                             | adds     |
| ------------------------------------------------ | -------- |
| one middleware that only calls `next()`          | +0.05 µs |
| the pathname sliced out of `req.url`             | +0.73 µs |
| `x-request-id` and `user-agent` read             | +1.29 µs |
| `crypto.randomUUID()`                            | +0.04 µs |
| `runWithContext` around the handler              | +0.91 µs |
| `x-request-id` set on the response               | −0.04 µs |
| the entry object, the timings, `Logger` dispatch | +0.80 µs |
| `new Date().toISOString()`, cached per ms        | +0.17 µs |
| building and serialising the line                | +2.05 µs |
| the write, batched                               | −0.62 µs |

Three suspicions were wrong and are worth recording as wrong:

- **`crypto.randomUUID()` is free.** 0.04 µs, an order of magnitude under the noise
  floor, and 90 ns in a hot loop. A per-process prefix plus a counter would save
  nothing measurable and would leak how many requests the process has served.
- **Losing the direct dispatch path costs nothing measurable.** A bare
  `next()`-only middleware is 0.05 µs. The 6 points that path is worth on `params`
  do not reappear as a cost here, because the request is already paying for
  everything else.
- **`response.headers.set` is free**, despite an isolated `Bun.serve` probe putting
  it at 0.70 µs. The isolated probe was measuring a different baseline; the harness
  is the arbiter.

What actually costs: **the first touch of `req.headers`** (1.29 µs — Bun
materialises the whole header map, and the inbound `x-request-id` is part of the
contract, so it is irreducible), the **`AsyncLocalStorage` scope** (0.91 µs, which is
what makes a handler's own log lines carry `requestId`), and **building and
serialising the entry** (2.05 µs, most of it `JSON.stringify`).

### The write was the largest single component, and batching removed it

One `console.log` per request measured **+1.24 µs** against not writing at all — more
than the `JSON.stringify` that produced the line. `ConsoleLogger` now concatenates
entries at `info` and below into one string and writes it once per event-loop turn,
and the write becomes **unmeasurable** (−0.62 µs against the serialise-only row, i.e.
inside the noise floor). It also largely defuses the blocked-pipe case: with batching
an unread pipe costs 1.16 µs instead of 2.68.

Things that were measured and did **not** work, all in a real `Bun.serve` handler:

| Strategy                                       | vs no write |
| ---------------------------------------------- | ----------- |
| `console.log(line)`                            | +1.84 µs    |
| `process.stdout.write(line + '\n')`            | +1.44 µs    |
| `process.stdout.write(encoder.encode(line))`   | +1.43 µs    |
| `Bun.stdout.writer({ highWaterMark: 64 KiB })` | +1.37 µs    |
| the same sink at 4 KiB                         | +1.86 µs    |
| batch into an array, flush on a **microtask**  | +1.48 µs    |
| concatenate, flush on a **macrotask**          | +0.27 µs    |

**`Bun.stdout.writer()` is the Bun-native API and it lost**, which is the one place
this work went against Rule 1's ordering. A `FileSink.write()` encodes into its own
buffer on every call, so it pays per entry exactly what it was meant to save; a JS
string concatenation is a rope and pays almost nothing. Only the _flush_ is a write,
and once per turn it does not matter which API performs it — so the flush goes
through `console.log`, which is also what keeps `console` interception working in
tests.

**Microtask batching does not batch.** Microtasks drain after essentially every
request, so the batch size is one and the cost is the same as writing directly. The
macrotask turn is what lets Bun accumulate a real batch.

### The durability trade, and what bounds it

A line still sitting in the buffer is lost if the process dies without unwinding — a
`SIGKILL`, an OOM kill, a segfault — which is exactly when a log matters most. Three
things bound it, and they are asserted in `packages/core/src/logger/console.test.ts`:

- **`warn`, `error` and `fatal` are never buffered.** They go out immediately _and_
  flush everything queued behind them, so the entries you go looking for after a
  crash — and everything that led up to them — were never held back. This is what
  makes the trade acceptable rather than merely fast.
- The window is **one event-loop turn**, not a timer interval.
- `flush()` is public, `onShutdown()` calls it so the container flushes on a
  graceful stop, and `process.on('exit')` catches the rest.
- `new ConsoleLogger(context, level, false)` opts out entirely.

### The other two changes

**`request-logging.ts` has no `async` function left in it.** `#body` and
`#responseFields` were `async` and, with both body options off — the default — they
returned `{}` immediately, so every request paid two async frames and two `await`s on
values that were never promises. They now return `Promise<unknown> | undefined`,
where `undefined` means there is nothing to read and the caller stays synchronous,
and the scope callback passed to `runWithContext` is a plain function using `.then`
rather than an `async` arrow. This is the same fault the input reader had, found the
same way, and an isolated probe puts an `async` scope callback at 0.44 µs over a
synchronous one. The pathname and the query string now come out of **one** pair of
`indexOf` calls instead of scanning `req.url` twice.

**`ConsoleLogger` has a fast path for `logger.info(string, object)`**, which is the
shape every framework call has. The general path spends two array allocations (the
rest parameter, then `[message, ...rest]`), a third object and an `Object.assign` to
reach an entry the fast path builds as one literal. The timestamp is cached by
millisecond: at any rate worth logging, `Date.now()` has not moved since the previous
entry, and `new Date().toISOString()` measured ~170 ns.

### Rejected: skipping the entry when the level would drop it

`Logger` exposes `logLevel`, so `RequestLoggingMiddleware` could check at
construction whether `info` survives and skip building the `request` object. It was
not done. The default level _is_ `info`, so the gate never fires in the configuration
being optimised; and a 4xx logs at `warn` and a 5xx at `error`, both of which need
the same `request` object, which is not known until after `next()` resolves. The
branch would add a field and a condition to buy nothing on the default path.

### Rejected: a cheaper request id

Covered above — `crypto.randomUUID()` measured at 0.04 µs, and a counter-based id
would trade an unmeasurable saving for leaking request volume in a header that is
returned to the caller.

### What still costs

The remaining ~5.4 µs over `requestLogging: false` is **~1.3 µs of `req.headers`,
~0.9 µs of `AsyncLocalStorage`, ~2.1 µs of entry construction and
`JSON.stringify`**, and ~0.7 µs of reading `req.url`. The first two are the contract:
an inbound `x-request-id` has to be honoured and a handler's own log lines have to
carry the id. The third is the one with room left, and the obvious move — hand-rolling
a serialiser instead of `JSON.stringify` — is a JavaScript reimplementation of a
platform primitive with string escaping to get wrong, which Rule 1 forbids. One real
saving is available and blocked on a contract: `RequestContext.getContext()` returns
a copy, and `ConsoleLogger` then spreads that copy into the entry, so the request
fields are copied twice per line. Removing one copy means either changing what
`getContext()` returns — which `@arkv/logger`'s `ContextStore` also implements — or
changing the order of the keys in every log line.
