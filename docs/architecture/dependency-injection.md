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

## Modules group registrations; they do not encapsulate

> **Superseded, and kept because the reasoning is still the argument that has to be
> answered.** This section describes the container as it is built today. The flat
> container, the absent `exports` and the absent `@Global()` are being replaced by a
> scope per module, per the **P0** in
> [../roadmap/module-scoped-di.md](../roadmap/module-scoped-di.md). What that document
> owes this one is an answer to every property claimed below, and it has a table doing
> exactly that. Do not read the rest of this section as current intent.

The syntax is Nest's. The semantics are not, and that distinction is the whole
point - an earlier draft of this document argued for plain-object modules, but the
argument was always about semantics and the object literal was never load-bearing.

The container is flat. `imports` exists, but it is **traversal only** - it pulls a
module's registrations into the same flat container. There is no `exports` list, no
visibility boundary, and therefore no "provider is not exported from module X"
error. `AppFactory.create(RootModule)` walks the import graph, imports before
importers so dependencies register first, and visits each module once - which makes
a diamond import register once rather than tripping the duplicate-binding check,
and makes a circular import terminate instead of erroring. A module is a named list
of registrations and a list of other modules to include.

So the encapsulation Nest gives you is absent by design. It is also largely
recoverable elsewhere: `inject(BillingService)` needs a value import of
`BillingService`, so cross-domain coupling is already visible in the import graph
and enforceable with a lint boundary rule at zero runtime cost. What is genuinely
lost is per-module _rebinding_ - a `LOGGER` token bound differently in two
features. Use two tokens. That is the price of the flat container.

This is the largest deliberate divergence from Nest and the first thing users
will notice. It should be loud in the README.

Two modules binding the same token is therefore a real hazard, and last-wins would
be silent. `app.init()` collects every module's registrations into one flat list
and **throws on a duplicate token**, naming both modules - the same rule as route
collisions.

That leaves no room for overrides to be an extra module that wins, so
`createTestApp({ modules, overrides })` does not append. It assembles the same flat
list and **replaces in place**, keyed by token; an override naming a token nobody
binds is itself an error. The count per token never changes, so the duplicate check
still runs unmodified and there is no bypass. Replacement also means a discarded
provider's factory never runs - which matters when it is the async `useFactory`
that opens the real database.

Built, as `AppFactory.create(root, { overrides })` in core with `@dunx/testing`
wrapping it. See "Test harness (`@dunx/testing`)" below for what that cost.

## Configured modules, and why there is no `forRootAsync`

A module that needs options exposes a static factory returning a `DynamicModule` -
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

A bare class is visited once however many modules import it - that is what makes a
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
