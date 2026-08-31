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

No `@Injectable()`. No `@Inject()`. No `reflect-metadata`.

## How constructor injection works

Add one line to `bunfig.toml`:

```toml
preload = ["@dunx/transform/preload"]
```

`@dunx/transform` reads each class's constructor parameter types as the file
loads and records them on the class. The container resolves them before calling
`new`. Nothing annotates the class, and nothing annotates the parameter.

Three consequences you can rely on:

- **Declaration order does not matter.** The record is evaluated at resolution
  time, so a dependency declared later in the same file, or reached across a
  circular import, resolves normally. There is no `forwardRef` in dunx.
- **A genuine cycle is still an error.** `A` needing `B` while `B` needs `A`
  fails at boot with the full path. See [Cycles](#cycles).
- **An unrecoverable type is a boot error**, not a silent `undefined`. See
  [When the type cannot be recovered](#when-the-type-cannot-be-recovered).

A class with constructor parameters and no record means the preload never ran,
and the container says so at boot with the snippet above.

It checks the entrypoint before choosing that snippet. The plugin's filter is
`/\.tsx?$/`, so it never sees an emitted `.js` no matter how it is preloaded. When
`Bun.main` ends in `.js`, `.cjs` or `.mjs` the message says the tree is prebuilt and
prints the build-time fix instead:

```
import { depsPlugin } from '@dunx/transform';
await Bun.build({ /* ... */ plugins: [depsPlugin] });
```

How the transform rewrites the source, and why the record is a thunk:
[Dependency injection](../architecture/dependency-injection.md).

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

`@Module` uses the opposite rule. Module options are read with `Object.hasOwn`,
so subclassing a module does not silently inherit its bindings. Constructors are
inherited by the language and dependencies follow them. Module options are not.

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

For comparison, `emitDecoratorMetadata` given
`constructor(db: Db, cache: Cache, n: number)` yields `["Db", "Object", "Number"]`.
An interface degrades to `Object` and a primitive to `Number`, indistinguishably.
A metadata-driven container then needs `@Inject(TOKEN)` for everything that is
not a class. The dunx transform reads the difference from source and names the
parameter.

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

`Logger` and `RequestContext` in `@dunx/core` are both abstract classes for this
reason, and [`examples/full`](../../examples/full) uses zero `token()` calls for
services.

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

Both mechanisms may appear in one class. Use `inject()` when there is no
constructor parameter for the value to hang off. In practice that means a
`Token<T>`: a token is a value rather than a type, so it cannot be a parameter
type and the transform has nothing to record.

The window is narrow. Constructor arguments resolve _before_ the injector is
made ambient, since argument resolution recurses back through `get()` and must
not see the class being built as its own scope. A module-level current injector
is then set around the `new Klass()` call, so an `inject()` in a field
initializer resolves against it.

Field initializers run synchronously inside the constructor, so this costs no
async gap and no `AsyncLocalStorage`.

Calling it anywhere else throws:

```
inject(Clock) was called outside of construction. inject() only works in a field
initializer or constructor of a class the container builds, because that is what
decides which module scope the token resolves from.
```

**A factory cannot use `inject()`.** After a factory's first `await`, the
module-level current injector is no longer its own. Declare factory dependencies
with `inject: [...]` on the provider instead. Despite the shared name, that
option and the `inject()` function are separate mechanisms.

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

Three kinds, and the list is complete.

`useValue` is checked against the token's type. `provide()` stays a _call_ rather
than a `{ provide, useValue }` object literal because per-element type inference
across a heterogeneous array requires one. The object-literal form is untyped for
want of it.

`useFactory` takes its dependencies from `inject`, positionally, with no generics
written by hand. The factory's parameters are typed from the tuple. A factory may
be `async`, and the container awaits it before any constructor that needs it runs.

`useClass` binds one token to a different constructor, which is how an abstract
contract gets an implementation and how a test override swaps one without touching
the module.

**There is no `useExisting`.** Alias one token to another with
`provide(Alias, { useFactory: (real) => real, inject: [Real] })`. `ConfigModule`
uses that to bind both `ConfigService` and your subclass to one instance.

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

A self-bind lands in **the scope that asked for it** rather than in a global
pool. Two modules that each inject an unlisted collaborator get one each, so an
accidental instance stays local instead of leaking across features.

An unbound token that is _not_ a class fails cleanly, and the message is answered
from the whole graph:

```
Cannot resolve BuildStamp for ReleaseService in module "ReleaseModule". Nothing in
the module graph declares it. Bind it with provide() in a module's providers, and
export it if the consumer is in a different module.
```

## Scope: singletons, and only singletons

Every provider is a singleton **in the module that declares it**, for the
lifetime of the container. An importer resolving it through `exports` gets that
same instance, so `DbConnection` exported by `DbModule` is one connection however
many modules import it. Two modules that each _declare_ the same class get two
instances: that is rebinding.

There is no `Scope.REQUEST`, no `Scope.TRANSIENT`, and no plan to add either.
Request-scoped DI was measured and turned down as a container's largest source of
complexity and per-request cost.

Per-request state travels as an explicit argument. Correlation data travels
through `RequestContext`, an `AsyncLocalStorage` that never touches the
container.

Full lifetime, boot order, hooks and error propagation: [Lifecycle](./07-lifecycle.md).

## Eager resolution

`AppFactory.create()` instantiates every declared binding and awaits every async
factory before it returns, so wiring errors surface at boot rather than at first
request. There is no separate `init()`.

Two kinds of provider sit outside that. A class that self-binds because no module
declared it, and the `Logger` / `RequestContext` defaults the container promotes into
every scope, are built on first `get`. A provider nothing ever asks for is therefore
never constructed, and never gets an `onInit` or an `onShutdown`.

That is also what keeps `inject()` synchronous: by the time any constructor runs,
every async provider has resolved.

The mechanism leaks into one rule you have to follow, so it is worth a paragraph.
There is no static graph to topologically sort: `inject()` calls are discovered
only by running field initializers.

Construction is therefore recursive and synchronous. An async factory reached
from inside a constructor parks its promise, throws a private signal to unwind,
and the async caller awaits that token and _retries_ the construction. Each retry
resolves at least one more async binding, so it terminates in at most one pass
per async dependency. Parking the promise before throwing keeps any factory from
running twice.

**The rule that follows: field initializers must stay pure wiring.** A constructor
aborted by that retry runs its already-evaluated field initializers again. An
`inject()` call is fine. Incrementing a counter, pushing to a shared array or
opening a socket in a field initializer is not.

## Lifecycle

Three hooks, all structural. Implement the method and the container finds it; the
`implements` clause only makes TypeScript check the signature. `OnInit` and
`OnShutdown` are below; `OnBeforeShutdown` runs while the server is still accepting
and is covered in [Lifecycle](./07-lifecycle.md).

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
early is torn down last, after every repository that uses it. Reversing
construction-completion order is already a dependency-aware teardown, so
`app.shutdown()` needs no separate pass.

For an HTTP application there are three steps in front of that.
`HttpApp.shutdown()` runs the container's `drain()`, then stops the `Bun.serve`
server, then closes `PubSub`, then delegates to the container's teardown. Draining
before the port closes is what lets a readiness probe fail while the server is still
answering; requests in flight then finish against providers that are still alive.

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

A token has one binding **per module**, so the only thing left to reject is the same
token declared twice in one module:

```
Duplicate binding for Options in module "StoreModule": it is declared twice in the
same module. A DynamicModule unions its options with the ones its class's @Module
decorator declares, so a forRoot() in each place is two bindings.
```

Two _different_ modules binding one token is legal per-module rebinding, and
gives two instances silently.

Two other shapes are legal but **warned** at boot, being more often a mistake
than an intent: declaring what an import already exports, and importing one token
from two modules that disagree. [Modules](./04-modules.md) has all four cases in
one table.

## Overrides, for tests

`AppFactory.create(root, { overrides })` replaces a binding **in place**, keyed by
token, in every scope that holds it:

```ts
import { createTestApp } from '@dunx/testing';
import { provide } from '@dunx/core';

const app = await createTestApp({
  modules: [UsersModule],
  overrides: [provide(Clock, { useValue: new FixedClock('2026-01-01') })],
});
```

Every scope, so a test stubbing `Logger` does not have to know how many modules bind
it. There is no `in:` option to name one: where two scopes bind a token differently
and only one is meant, resolve through the module that matters instead.

Replacement rather than addition, and the distinction matters twice over. The
discarded provider is never instantiated, so its `useFactory` never runs and its
`onInit` never fires. That is what makes overriding a database safe.

An override naming a **non-class** token nobody binds is an error rather than a
silent no-op:

```
Nothing to override for DSN: no module in the graph binds it, and it is not a class,
so nothing self-binds it either. An override replaces a binding - it cannot add one,
because a token nobody bound is a token nothing under test resolves.
```

A **class** token nobody bound is accepted, and registered lazily. A class self-binds
on demand anyway, so the override is replacing the binding that would otherwise have
appeared rather than adding one. An abstract class counts as a class here: the check
is `typeof token === 'function'`.

`Logger` and `RequestContext` are substituted too, so overriding `Logger` works in
an app that binds none. `@dunx/testing` ships a `RecordingLogger` for exactly
that.

## Next

[Modules](./04-modules.md) for how providers are grouped, ordered and configured.
[Controllers](./05-controllers.md) for the providers that have routes on them.
