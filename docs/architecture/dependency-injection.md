# Dependency injection

The decorator dialect, how constructor types are recorded without metadata, and why modules group rather than encapsulate.

## The decorator dialect decision

`tsyringe` and `@Inject()`-style constructor injection are locked to legacy
`experimentalDecorators` **permanently**: TC39 standard decorators have no
parameter decorators, so `constructor(@inject(X) x: X)` has no migration path.
Building a new framework on the dialect TypeScript is walking away from, in
order to buy a lossy metadata table you then work around, is a bad trade.

dunx uses **standard decorators only**. The root `tsconfig.json` must not set
`experimentalDecorators` or `emitDecoratorMetadata`.

That rules out the _decorator_ route to constructor injection. It does not rule
out constructor injection - see below.

## Constructor injection without decorator metadata

An earlier draft of this document concluded that constructor injection was
unavailable and that `inject()` in field initializers was the only option. That
conclusion was wrong: it assumed the parameter types had to be recovered at
runtime, which is the only thing decorators could have done. They can be read at
**load time** instead, from the source that still has them.

`@dunx/transform` is a Bun plugin. On load it parses each file with `oxc-parser`,
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
So the user-facing syntax carries **no annotation at all** - no `@Injectable`, no
`@Inject`, no `inject()`, no `reflect-metadata`, no `experimentalDecorators`.

### Registering the transform

Three ways, same plugin object:

```toml
# bunfig.toml - for `bun run` and `bun test`
preload = ["@dunx/transform/preload"]

[test]
preload = ["@dunx/transform/preload"]
```

```bash
bun --preload @dunx/transform/preload src/main.ts   # no config file at all
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
recorded for it, so @dunx/transform did not transform UsersController.
Register the plugin, then retry:

  # bunfig.toml
  preload = ["@dunx/transform/preload"]
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
class - `new HttpError(404, 'x')` also has constructor parameters. So it records
metadata for every annotated class and lets the container raise the error only if
something is actually resolved as a provider. That is why the error is a boot
error and not a build error.

`inject()` remains available for a value with no constructor parameter to hang
off, and both mechanisms may be used in the same class.

## Core primitives (`@dunx/core`)

There is no `@Injectable()` - every class is injectable by default.

| Primitive                                              | Purpose                                                  |
| ------------------------------------------------------ | -------------------------------------------------------- |
| `constructor(private readonly x: X)`                   | The default. Resolved from the parameter's type          |
| `inject<T>(token): T`                                  | Escape hatch, in a field initializer. Always synchronous |
| `token<T>(name)`                                       | Opaque token for interfaces, config objects, primitives  |
| `provide(token, {useClass \| useValue \| useFactory})` | Binding, including async factories                       |
| `@Module({imports, providers})`                        | Class decorator. Registration only - see below           |
| `AppFactory.create(RootModule)`                        | Builds, resolves, runs `onInit`. Returns a live `App`    |

`AppFactory.create()` is async and there is no separate `init()`: resolution is
eager, so an app that exists is an app that booted. `app.enableShutdownHooks()`
registers `SIGTERM`/`SIGINT` handlers and `app.closed` resolves once shutdown has
finished, whoever triggered it.

### `token()` is the escape hatch, not the default

Anything that is a **runtime value** can be its own token, so most code needs no
`token()` call at all. In order of preference:

1. **A concrete class** - `inject(Config)`. Nothing to declare; an unbound class
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

An `interface` is erased at compile time, so `inject(SomeInterface)` cannot exist -
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
`Symbol.for('dunx.module')` property - the same technique as route discovery, no
accumulator - and the class is **never instantiated**. Reading it uses
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

`provide()` is only needed where a token is genuinely being bound - an interface, a
config object, an async factory - which is exactly where Nest needs its object form
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

There is no static graph to topologically sort - `inject()` calls are only
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

## Modules encapsulate: `exports`, `global`, and a scope each

**This replaced a flat container, and the section that argued for one is worth reading
in the history rather than here.** The short version of what changed and why: the flat
container had no `exports`, no visibility boundary and therefore no "provider is not
exported from module X" error, and it was defended on those grounds. What it could not
express was **module-scoped middleware** - a module providing a guard for its own
routes, resolved from its own scope - or per-module rebinding. A DI framework is
expected to have both. Nobody was consuming dunx yet, so the reversal cost no
migration.

The model is three concepts.

**A scope is a module.** Every module _reference_ in the graph gets its own set of
bindings. Two different configurations of one class are two scopes, which is consistent
with the per-reference deduplication `collectModules` already did.

**`exports` is visibility.** A module lists the tokens an importer may resolve;
everything else stays private. It accepts a token or a `ModuleRef`, and a `ModuleRef`
re-exports whatever that module exports - which is what lets `DatabaseModule` pass the
drizzle handle on so a feature module imports _it_ rather than `@dunx/infra/db`.

**`global: true`** publishes a module's exports to every scope with no import needed.
`ConfigModule` and `LoggerModule` are global because configuration and the `Logger`
contract are read everywhere; `@dunx/http`'s own wrapper is global because it _imports_
the app's root rather than being imported by it, so its `PubSub` would otherwise be
invisible to the whole app.

### Resolution, and why it is still one lookup

For a token requested while constructing a provider in module `M`: `M`'s own
providers, then the exports of what `M` imports, then the global scope. **Local shadows
imported**, which is the rebinding this exists to allow.

Visibility is **flattened once at boot** into one `Map` per scope. Walking an import
chain per lookup would make every construction O(depth); computing the closure once
keeps resolution the single `Map.get` it was when the container was flat and moves the
cost to boot, which is the trade this architecture makes everywhere else. A boot-time
regression was accepted deliberately for the encapsulation.

Instance caches key on the **binding**, not the token, so two modules that each declare
one class hold two instances.

### What replaced the duplicate-binding check

It could not survive intact, because repetition across scopes is the feature. It split
into three:

- The same token twice **in one module** is still an error.
- Two modules binding one token is legal and silent.
- An importer seeing one token from two imports is legal, takes the **last**, and
  **warns** - naming both modules. Only when the bindings actually differ, so a diamond
  re-export stays silent. Warnings surface on `App.warnings` rather than being logged,
  because core has no logger and the caller knows what level they belong at.

Nest is silent here and it costs people hours, which is why the warning exists.

### Circular imports still need no `forwardRef`

That never came from flatness. It comes from the **deps thunk**: `@dunx/transform`
writes `Symbol.for('dunx.deps')` as a function and `readDeps` calls it at resolution,
so a circular ES import already resolves and scoping does not touch it.

Three cycles, only one of them new:

1. **Module import cycles** terminate as before - `collectModules` visits each reference
   once.
2. **Re-export cycles** are the new case: `A exports B` and `B exports A` makes each
   export set depend on the other. It is not a real cycle, because an export set is a
   union and union is monotonic, so the sets are computed to a **fixed point**.
3. **Provider cycles** are still a boot error with the full path, and must stay one.
   `forwardRef` in Nest largely exists to paper over exactly this.

Resolution order comes from the **provider** graph, not the module graph, which is what
lets a module cycle whose providers have no cycle resolve fine.

### `app.get()` is deliberately more permissive

Constructor injection is strict. `app.get(token)` tries the root scope's view, then any
single module that declares the token, and errors on ambiguity; `app.get(token, Module)`
_prefers_ that module's view and falls back to the same search. It is a bootstrap and
debugging call rather than a dependency edge, and requiring every caller to know the
owning module would make `exports` painful for no safety gain.

### `forRootAsync` factories take `imports`

A factory passed to `forRootAsync` is written at the call site but produces a provider
in the **configured** module's scope - so one injecting `DbConnection` is asking a
library module to resolve a token only the app can see. `AsyncModuleConfig` adds
`imports` for that, which is the field Nest's `forRootAsync({ imports })` fills. A token
from a global module needs nothing, which is why most factories carry no `imports` at
all.

### The error is the feature

`exports` reintroduces the most complained-about error in the Nest ecosystem, so dunx
answers it from the whole graph, which is known at boot:

```
Cannot resolve UsersRepository for ReportsService in module "ReportsModule".
"UsersModule" declares it and "ReportsModule" imports that module, but it does not
export UsersRepository. Add UsersRepository to that module's exports, or move the
provider into "ReportsModule".
```

Every branch is answerable: declared-but-not-exported, declared-but-not-imported,
declared-nowhere. Two findings from the migration are baked in - a class token nothing
_visible_ binds no longer silently self-binds when some module declares it (that
reported "did the transform run?" instead of the real problem), and a module exporting
a token it neither declares nor can reach is caught where the mistake is rather than in
some other module.

### Overrides replace in every scope

`createTestApp({ overrides })` replaces a token's binding in **every** scope that holds
it. A suite stubbing `Logger` should not have to know how many modules bind it, and
making it name a scope would push container topology into every test. "An override that
replaced nothing is an error" still holds, and matters more here: it catches an override
aimed at a token that has moved behind a boundary.

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

A guard is still middleware that throws - there is no `CanActivate`. What
`@UseGuards`, `@Roles` and `@Public` added is not a sixth extension point but a
**scope** and a **metadata channel** for the one that already existed. `ctx.get(key)`
reads metadata merged handler-first-then-class at discovery, so a method-level
`@Public()` overrides a class-level `@Roles()`.

Guards are middleware that throw. Interceptors wrap `next()`. Pipes become
schema validation in the route options. Filters become one error mapper. Chains
compose into a single closure per route **at boot** - no per-request array
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
