# Providers

A provider is anything the container can hand you: a service, a repository, a
configuration object, a database connection. Most of them are plain classes listed
in a module's `providers`, and injecting one is a constructor parameter with no
annotation of any kind.

```ts
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}
}
```

No `@Injectable()`. No `@Inject()`. No `reflect-metadata`. This page explains how
that works, where it stops working, and what to do at each of those edges.

## How constructor injection works

`@dunx/transform` is a Bun plugin registered by one line in `bunfig.toml`. On load
it parses each `.ts` file with `oxc-parser`, reads every class declaration's
constructor parameter types, and appends one statement after the class:

```ts
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}
}
Object.defineProperty(UsersService, Symbol.for('dunx.deps'), {
  value: () => [UsersRepository],
});
```

That is the whole mechanism. The container reads the record and resolves the
arguments before calling `new`.

`Symbol.for`, not `Symbol`, so two copies of `@dunx/core` in one dependency tree
still agree on the key. The same technique carries module options and route
metadata.

The transform is the reason dunx can offer constructor injection at all without
the legacy decorator dialect. `tsyringe` and every `@Inject()` parameter decorator are locked to
`experimentalDecorators` permanently, because TC39 standard decorators have no
parameter decorators and `constructor(@inject(X) x: X)` has no migration path.
Reading the types at load time, from the source that still has them, sidesteps the
question.

### Why the record is a thunk

`value: () => [UsersRepository]`, not `value: [UsersRepository]`. The body is
evaluated when the record is read, at resolution time, rather than when the module
is defined.

An eagerly evaluated array would be a temporal dead zone crash for a dependency
declared later in the same file:

```ts
export class Orders {
  constructor(private readonly pricing: Pricing) {}
}

// Declared after the class that depends on it. Fine: nothing reads the
// record until the container resolves Orders.
export class Pricing {}
```

and for a dependency reached across a circular import, where one of the two
modules is necessarily still evaluating when the other's record is written.

Deferring the body is what removes the need for a `forwardRef` escape hatch. There is no
`forwardRef` in dunx and there is nothing to replace it with, because the problem
it solves does not arise.

Note that a genuine dependency _cycle_ is still an error. A thunk fixes the
ordering of _declarations_; it cannot make `A` need `B` while `B` needs `A`. See
[Cycles](#cycles) below.

### Inheritance

`readDeps` does a plain prototype-chain lookup rather than `Object.hasOwn`. A
subclass that declares no constructor of its own inherits its base's constructor,
so it must inherit the base's dependencies with it:

```ts
export abstract class Repository {
  constructor(protected readonly db: Database) {}
}

// No constructor. Inherits Repository's, and its dependency record with it.
export class UsersRepository extends Repository {
  findAll() {
    return this.db.select().from(users);
  }
}
```

A subclass that _does_ declare a constructor gets its own record from the
transform, which shadows the base's.

This is the opposite of the rule `@Module` uses, and the difference is
deliberate. Module options are read with `Object.hasOwn`, so subclassing a module
does not silently inherit its bindings. Constructors are inherited by the language
and dependencies follow them; module options are not.

## When the type cannot be recovered

The transform reads names out of source text. A parameter whose type names nothing
that exists at runtime is recorded as `unresolved`, along with the parameter's
original text, and becomes a boot error naming it:

```
UsersService cannot be constructed: parameter 2 (private readonly cfg: AppConfig)
names nothing that exists at runtime, so there is no token to resolve. Replace the
type with an abstract class, or bind it with token() and declare the parameter as
that token.
```

Six cases are detected this way:

| Parameter type             | Why it is erased                                   |
| -------------------------- | -------------------------------------------------- |
| a local `interface`        | Interfaces have no runtime value                   |
| a local `type` alias       | Same                                               |
| a type-only import         | `import type { X }` emits nothing                  |
| an inline `type` specifier | `import { type X }` emits nothing for `X`          |
| a class type parameter     | `class Box<T> { constructor(x: T) {} }` erases `T` |
| a primitive or a union     | `number`, `string`, `A \| B` are not tokens        |

This is strictly better than what `emitDecoratorMetadata` does, and that was
measured rather than assumed. Given
`constructor(db: Db, cache: Cache, n: number)` the legacy metadata table yields
`["Db", "Object", "Number"]`: an interface degrades to `Object` and a primitive to
`Number`, indistinguishably. That is why a metadata-driven container needs `@Inject(TOKEN)` for
everything that is not a class. The transform can see the difference in the
source, so it names the parameter instead of degrading it.

The fix is one of two things. If the erased type is a contract implemented
elsewhere, make it an `abstract class`, which is a runtime value and therefore a
usable token:

```ts
// Not `interface Clock`.
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}

// In a module:
provide(Clock, { useClass: SystemClock });

// At the injection site, unchanged:
export class Invoices {
  constructor(private readonly clock: Clock) {}
}
```

That is exactly how `Logger` and `RequestContext` work in `@dunx/core`, and it is
why [`examples/full`](../../examples/full) uses zero `token()` calls for services.

If there is genuinely no class worth writing, use `token()` and reach it with
`inject()`. Both are below.

## `inject()`, the escape hatch

`inject(token)` resolves a value from inside a field initializer:

```ts
import { inject, Logger, type OnInit } from '@dunx/core';
import { BUILD_STAMP, FEATURE_FLAGS } from './tokens.js';

export class BuildInfo implements OnInit {
  readonly #stamp = inject(BUILD_STAMP);
  readonly #flags = inject(FEATURE_FLAGS);

  constructor(private readonly logger: Logger) {}

  onInit(): void {
    this.logger.info(
      `build ${this.#stamp.revision}, flags [${[...this.#flags].join(', ')}]`,
    );
  }
}
```

Both mechanisms in one class, which is supported and occasionally the right
answer. Use `inject()` when there is no constructor parameter for the value to
hang off, which in practice means a `Token<T>`: a token is a value, not a type, so
it cannot be written as a parameter type and the transform has nothing to record.

The window is narrow and the mechanism is worth knowing. Constructor arguments are
resolved _before_ the injector is made ambient, because argument resolution
recurses back through `get()` and must not see the class being built as its own
scope. A module-level current injector is then set around the `new Klass()` call
itself, so any `inject()` in a field initializer resolves against it. Field
initializers run synchronously inside the constructor, so there is no async gap
and no `AsyncLocalStorage` cost.

Calling it anywhere else throws:

```
inject(Clock) was called outside of construction. inject() only works in a field
initializer or constructor of a class the container builds.
```

**A factory cannot use `inject()`.** After a factory's first `await`, the
module-level current injector is no longer its own. Factory dependencies are
declared instead, and that is what `inject: [...]` on a `useFactory` provider is
for. It is a different thing from the `inject()` function despite the shared name.

Both paths go through the same `get()`, so cycle detection, duplicate-binding
rejection and the async-factory retry apply identically whether a dependency
arrived as a constructor parameter or as an `inject()` call.

## `provide()` in all its shapes

A bare class in `providers` is shorthand for binding it to itself, and that covers
most of an application. `provide()` is for the rest: a token, a constant, a
computed value, or an implementation chosen at wiring time.

```ts
import { Module, provide } from '@dunx/core';

@Module({
  providers: [
    // useValue: a constant, resolved before anything asks for it.
    provide(FEATURE_FLAGS, {
      useValue: new Set(['transactions', 'websockets']),
    }),

    // useFactory: computed once, at boot, from other bindings.
    provide(BUILD_STAMP, {
      useFactory: (config: AppConfigService): BuildStamp => ({
        startedAt: new Date().toISOString(),
        revision: `${config.get('appName')}-dev`,
      }),
      inject: [AppConfigService] as const,
    }),

    // useClass: the long form of listing the bare class.
    provide(BuildInfo, { useClass: BuildInfo }),

    // The shorthand for the line above.
    WiringDemo,
  ],
})
export class WiringModule {}
```

Three kinds, and that is the complete list.

`useValue` is checked against the token's type. This is the one place dunx's typing
beats the object-literal form directly: `provide()` stays a _call_ rather than a
`{ provide, useValue }` object literal because per-element type inference across a
heterogeneous array requires one, which is precisely why the object-literal `useValue` is
untyped.

`useFactory` takes its dependencies from `inject`, positionally, with no generics
written by hand. The factory's parameters are typed from the tuple. A factory may
be `async`, and the container awaits it before any constructor that needs it runs.

`useClass` binds one token to a different constructor, which is how an abstract
contract gets an implementation and how a test override swaps one without touching
the module.

**There is no `useExisting`.** Aliasing one token to another is
`provide(Alias, { useFactory: (real) => real, inject: [Real] })`, which is the same
thing without a fourth provider kind to document. `ConfigModule` uses exactly that
to bind both `ConfigService` and your subclass to one instance.

## Tokens

Three ways to name a binding, in order of preference.

**A concrete class.** Nothing to declare. An unbound class self-binds, so
`constructor(private readonly repo: UsersRepository)` works whether or not
`UsersRepository` appears in any `providers` list.

**An abstract class**, for a contract whose implementation is chosen elsewhere. It
is a runtime value, so it works as a token; it cannot be constructed, so the
container will not self-bind it by accident. `Logger` and `RequestContext` in
`@dunx/core` are both this.

**`token<T>(description)`**, only for what has no runtime value to name:

```ts
import { token, type Token } from '@dunx/core';

export interface BuildStamp {
  readonly startedAt: string;
  readonly revision: string;
}

export const BUILD_STAMP: Token<BuildStamp> = token<BuildStamp>('BuildStamp');
export const FEATURE_FLAGS: Token<ReadonlySet<string>> =
  token<ReadonlySet<string>>('FeatureFlags');
```

`token<T>()` returns a unique object. The description is only a label for error
messages, so two `token<Config>('config')` calls are two distinct tokens and
nominal collision is impossible. No prefixing convention is needed.

The reason it is last on the list: a `Token<T>` cannot be written as a constructor
parameter type, so the transform cannot see it and `inject()` becomes the only way
to reach it. That asymmetry is why a class is better whenever a class exists.

### The self-binding hole

Every class is injectable by default, which is convenient and has one sharp edge
worth publishing.

`abstract` does not exist at runtime. An abstract class that is injected but never
bound therefore gets self-bound and constructed into a useless object rather than
erroring. TypeScript blocks it in the `providers` array, because a bare entry must
be constructible, but not at the `inject()` call site.

The same shape appears with options classes: a class whose constructor arguments
are all optional resolves successfully when nothing bound it, so
`app.get(QueueOptions)` on a container with no `QueueModule` returns defaults
rather than throwing. Any presence check for a class-shaped token has that hole.

An unbound token that is _not_ a class fails cleanly:

```
No provider for BuildStamp. Bind it with provide() in a module.
```

## Scope: singletons, and only singletons

Every provider is a singleton for the lifetime of the container. There is no
`Scope.REQUEST`, no `Scope.TRANSIENT`, and no plan to add either.

Request-scoped DI is a container's single biggest source of complexity and per-request
cost, and it was measured and turned down. Per-request state is passed as an
explicit argument. Request-scoped _context_, meaning logging correlation and the
like, is a separate `AsyncLocalStorage` concern behind `RequestContext` that never
touches the container. That is what carries `requestId` through a request without
a per-request provider graph.

## Eager resolution

`AppFactory.create()` instantiates every provider and awaits every async factory
before it returns. Wiring errors surface at boot, not at first request. There is
no separate `init()`, because an app that exists is an app that booted.

This is also what lets `inject()` stay synchronous: by the time any constructor
runs, every async provider is already resolved.

The mechanism behind that is worth one paragraph, because it leaks into one rule
you have to follow. There is no static graph to topologically sort, since
`inject()` calls are only discovered by running field initializers. So
construction is recursive and synchronous, and an async factory reached from
inside a constructor parks its promise, throws a private signal to unwind, and the
async caller awaits that token and _retries_ the construction. Each retry resolves
at least one more async binding, so it terminates in at most one pass per async
dependency, and a factory is never invoked twice because the promise is parked
before the signal is thrown.

**The rule that follows: field initializers must stay pure wiring.** A constructor
aborted by that retry runs its already-evaluated field initializers again. An
`inject()` call is fine. Incrementing a counter, pushing to a shared array or
opening a socket in a field initializer is not.

## Lifecycle

Two hooks, both structural. Implement the method and the container finds it; the
`implements` clause only makes TypeScript check the signature.

```ts
import type { OnInit, OnShutdown } from '@dunx/core';

export class Connection implements OnInit, OnShutdown {
  #handle: Handle | undefined;

  async onInit(): Promise<void> {
    this.#handle = await open();
  }

  async onShutdown(): Promise<void> {
    await this.#handle?.close();
  }
}
```

Both may return a promise, and both are awaited.

Note the split of responsibilities. Anything that must exist before a constructor
runs belongs in a `useFactory`, because factories are awaited during resolution.
`onInit` runs after the _entire_ graph is constructed, which makes it the right
place for work that depends on peers being ready: running migrations, seeding,
subscribing, or logging what the app resolved to.

## Ordering

Construction order is dependency order, and it is recorded as construction
_completion_ order: a value is appended to the container's list once it exists, so
a dependency always appears before its dependent.

Two things follow.

`onInit` runs in that order. A provider's dependencies have already had their
`onInit` called by the time its own runs.

`onShutdown` runs in exactly reverse order. A database connection constructed
early is torn down last, after every repository that uses it. That is what makes
`app.shutdown()` safe without a dependency-aware teardown pass: reversing
construction completion order already is one.

For an HTTP application there is one step in front of that. `HttpApp.shutdown()`
stops the `Bun.serve` server first, then closes `PubSub`, then delegates to the
container's teardown. Requests in flight finish against providers that are still
alive.

Beyond dependency order, the order tokens are _registered_ decides the rest, and
that is a module-graph question. [Modules](./04-modules.md) covers it: imports
register before importers, so a module listed first in `imports` is constructed
first and torn down last.

## Cycles

A real dependency cycle is a boot error carrying the full path:

```
Circular dependency: Alpha -> Beta -> Alpha
```

thrown as `CircularDependencyError`, which carries the path as a
`readonly string[]` on `error.cycle`. Without the in-flight tracking that produces
it, a field-initializer
cycle would be unbounded recursion with an unreadable stack.

To be precise about what is and is not a cycle: a circular _import_ between two
files is fine, because the dependency record is a thunk. A circular _dependency_,
where two providers each need the other constructed first, is not, and no
mechanism can make it one. Break it by extracting the shared piece into a third
provider, or by having one side depend on an event rather than an object.

## Duplicate bindings

The container is flat and one token has exactly one binding. Two modules binding
the same token throws, naming both:

```
Duplicate binding for Options: bound by module "StoreModule" and module
"StoreModule". The container is flat - one binding per token.
```

Last-wins would have been silent, and first-wins would depend on traversal order.
Neither is something a reader could predict. Note that both names can be the same
module, which happens when one module is imported twice with two different
configurations; [Modules](./04-modules.md) covers why that is not deduplicated.

## Overrides, for tests

`AppFactory.create(root, { overrides })` replaces a binding **in place**, keyed by
token, as the flat list is assembled:

```ts
import { createTestApp } from '@dunx/testing';
import { provide } from '@dunx/core';

const app = await createTestApp({
  modules: [UsersModule],
  overrides: [provide(Clock, { useValue: new FixedClock('2026-01-01') })],
});
```

Replacement, not addition, and the distinction matters three times over. A late
binding appended at the end would be a duplicate rather than a winner, so the
count per token never changes and the duplicate check still runs unmodified. The
discarded provider is never instantiated, so its `useFactory` never runs and its
`onInit` never fires, which is what makes overriding a database safe. And an
override naming a token nobody binds is an error rather than a silent no-op:

```
Nothing to override for Clock: no module in the graph binds it. An override
replaces a binding - it cannot add one, because a token nobody bound is a token
nothing under test resolves.
```

`Logger` and `RequestContext` are substituted too, so overriding `Logger` works in
an app that binds none. `@dunx/testing` ships a `RecordingLogger` for exactly
that.

## Next

[Modules](./04-modules.md) for how providers are grouped, ordered and configured.
[Controllers](./05-controllers.md) for the providers that have routes on them.
