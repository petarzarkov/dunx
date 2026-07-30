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
the token disappear. `examples/playground` uses zero `token()` calls for this
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
- **An async-safe transaction**, for the bun-sqlite quirk measured above.
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

Ship `@dunx/core` and a single `examples/playground` app that boots a fully
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

The playground is one app that grows through the phases, not a new example per
phase, and not one per package. Per-package examples were tried and reverted: seven
apps meant seven bootstraps to keep alive and nowhere that showed the packages
composing, which is the thing actually worth demonstrating.

Where a part needs a service CI does not have (Redis, Postgres, S3), it reports that
it is skipping and the app still exits 0 — otherwise CI teaches everyone to ignore
it.

### Phase 2 — HTTP

`@dunx/http`, the `Bun.serve` adapter, the middleware chain, the error mapper,
and route-collision detection. The playground grows a controller; its Phase 1
assertions keep passing unchanged.

Also `@dunx/compiler`, the load-time transform that makes constructor injection
work. It landed here rather than in Phase 1 because the need only became clear
once real application code was being written against `inject()`.

Exit criteria:

- A class with constructor parameters resolves without any annotation
- A parameter whose type is erased fails at boot naming that parameter
- A subclass with no constructor of its own inherits its base's dependencies
- `inject()` still works, and both mechanisms work in one class
- The playground uses constructor injection throughout and `bun start` exits 0

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
