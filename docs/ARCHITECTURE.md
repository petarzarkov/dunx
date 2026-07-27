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

## The decorator dialect decision

`tsyringe` and Nest-style constructor injection are locked to legacy
`experimentalDecorators` **permanently**: TC39 standard decorators have no
parameter decorators, so `constructor(@inject(X) x: X)` has no migration path.
Building a new framework on the dialect TypeScript is walking away from, in
order to buy a lossy metadata table you then work around, is a bad trade.

dunx uses **standard decorators only**. The root `tsconfig.json` must not set
`experimentalDecorators` or `emitDecoratorMetadata`.

## Core primitives (`@dunx/core`)

There is no `@Injectable()` — with `inject()` every class is injectable by default.

| Primitive                                              | Purpose                                                 |
| ------------------------------------------------------ | ------------------------------------------------------- |
| `inject<T>(token): T`                                  | Resolve in a field initializer. Always synchronous.     |
| `token<T>(name)`                                       | Opaque token for interfaces, config objects, primitives |
| `provide(token, {useClass \| useValue \| useFactory})` | Binding, including async factories                      |
| `@Module({imports, providers})`                        | Class decorator. Registration only — see below          |
| `DunxFactory.create(RootModule)`                       | Builds, resolves, runs `onInit`. Returns a live `App`   |

`DunxFactory.create()` is async and there is no separate `init()`: resolution is
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

A module-level `currentInjector` is set around each `new Klass()`. Field
initializers run synchronously inside the constructor, so there is no async gap
and no `AsyncLocalStorage` cost. Calling `inject()` outside construction throws
with a clear message.

### Eager-only, no lazy resolution

`DunxFactory.create()` instantiates every provider and awaits async factories
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
error. `DunxFactory.create(RootModule)` walks the import graph, imports before
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

## One extension point, not five

Nest has middleware, guards, interceptors, pipes, and filters. dunx has:

```ts
type Middleware = (
  req: BunRequest,
  next: () => Promise<Response>,
) => Promise<Response>;
```

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

Boot sequence, run after `app.init()` has constructed every provider:

1. Collect controllers from modules
2. Discover routes per controller — prototype-chain scan **plus** instance fields,
   as one merged set (see **Route discovery**). Zero routes throws
3. Join controller prefix + method path, normalize
4. **Detect collisions and throw** — Bun silently lets one route win
5. Build the `routes` object; each handler is a closure over the
   already-constructed instance and its bound method
6. Hand to `Bun.serve`

Step 2 needs the instance, not just the class: a field route does not exist until
the field initializer has run. That ordering is already guaranteed — `app.init()`
is eager and completes before the server binds.

Per request the framework does exactly four things: validate declared schemas,
call the method, pass a `Response` through or wrap the return in
`Response.json()`, and map thrown errors. No lookup, no DI, no metadata read.

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
  `@Module({ controllers })` is what registers a controller.
- **Overriding a decorated base method without re-decorating works.** The own
  undecorated member does not shadow discovery, and dispatch resolves through the
  prototype chain to the override.
- **Decorated methods and field routes are one merged set**, so collision
  detection covers both and a controller resolving to zero routes can throw.

No `Symbol.metadata`, no polyfill, no import-order dependence.

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
phase.

### Phase 2 — HTTP

`@dunx/http`, the `Bun.serve` adapter, the middleware chain, the error mapper,
and route-collision detection. The playground grows a controller; its Phase 1
assertions keep passing unchanged.

### Phase 3 — Validation

Standard Schema wiring and typed route input. Gated on the inference spike
below.

### Phase 4 — Testing & scaffolder

`@dunx/testing` (`createTestApp({ modules, overrides })`, real server on port 0)
and `@dunx/create-app`.

### Phase 5 — OpenAPI

Separate package, peer dependencies. Deferred because Standard Schema v1 has no
JSON Schema export, so this needs a per-library adapter (Zod 4's
`z.toJSONSchema`, etc.).

## Spikes to resolve

Run through `/spike`: measure on real Bun, record the result under **Verified
constraints** above, then delete the item from here. A spike that changes the
public API shape belongs before the code it gates.

1. **Route input inference.** Does `@Post(opts)` cleanly constrain the method
   signature through the method decorator's generic? A standard method decorator
   is `(value: V, ctx: ClassMethodDecoratorContext<T, V>) => V | void`, so it can
   _reject_ a mismatched `V` but cannot contextually type an unannotated
   parameter — expect checking, not inference, with an explicit
   `Ctx<typeof opts>` annotation as the shape. Gates Phase 3. This is a
   type-level claim, so `bun` alone cannot measure it — the probe needs `tsc`.
