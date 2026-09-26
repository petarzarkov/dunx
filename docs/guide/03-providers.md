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

The plugin parses each `.ts` and `.tsx` file with `oxc-parser` and appends one
statement after every class declaration:

```ts
export class GreetingsService {
  constructor(private readonly logger: Logger) {}
}
Object.defineProperty(GreetingsService, Symbol.for('dunx.deps'), {
  value: () => [Logger],
});
```

Files under `node_modules` are skipped: a published package was already
transformed by its own build.

A class with constructor parameters and no record means the preload never ran,
and the container says so at boot with the snippet above.

It detects this by comparing the record against `Function.prototype.length`,
which still reports the declared parameter count after parameter properties are
compiled away. A
constructor whose parameters all have defaults has `length === 0` and is genuinely
callable with no arguments, so there are no false positives.

The plugin only transforms `.ts` and `.tsx` files, so preloading it does nothing
for compiled `.js`. When `Bun.main` ends in `.js`, `.cjs` or `.mjs`, the error says
the code is prebuilt and shows the build-time fix instead:

```
import { depsPlugin } from '@dunx/transform';
await Bun.build({ /* ... */ plugins: [depsPlugin] });
```

Use the same `Bun.build` call for a production build. To skip `bunfig.toml`, run
`bun --preload @dunx/transform/preload src/main.ts`.

Importing `@dunx/core` does not register the plugin. A Bun plugin only affects
files loaded after it is registered, so injection would depend on import order.
It would also ship the parser to production for code that was already
transformed at build time.

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
type with an abstract class, or bind it with token() and read it with
inject(TOKEN) in a field initializer.
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

dunx reads the source, so the error names the exact parameter. Containers built
on `emitDecoratorMetadata` cannot do this. For
`constructor(db: Db, cache: Cache, n: number)` they record
`["Db", "Object", "Number"]`: the interface becomes `Object` and the primitive
becomes `Number`. That is why they need `@Inject(TOKEN)` for anything that is not
a class.

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

`inject()` only works while the container is running `new` on your class. The
container resolves the constructor arguments first, then sets the current
module scope for the duration of the `new` call. An `inject()` in a field
initializer resolves from that scope. Field initializers run synchronously
inside the constructor, so no `AsyncLocalStorage` is involved.

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

A constructor parameter and an `inject()` call resolve the same way. Cycle
detection, duplicate-binding errors and async factories behave the same for
both.

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

`useValue` is type-checked against the token. That check needs the `provide()`
function call: TypeScript cannot check a `{ provide, useValue }` object literal
inside a mixed `providers` array.

`useFactory` takes its dependencies from `inject`, positionally, with no generics
written by hand. The factory's parameters are typed from the tuple. A factory may
be `async`, and the container awaits it before any constructor that needs it runs.

`useClass` binds a token to a different class. Use it to give an abstract class
its implementation, or to swap an implementation in a test without editing the
module.

**There is no `useExisting`.** Alias one token to another with
`provide(Alias, { useFactory: (real) => real, inject: [Real] })`. `ConfigModule`
uses that to bind both `ConfigService` and your subclass to one instance.

## Tokens

Three ways to name a binding, in order of preference.

**A concrete class.** Nothing to declare.
`constructor(private readonly repo: UsersRepository)` works without
`UsersRepository` in a `providers` list, as long as only one module injects it.
An unlisted class is registered in the module that asks for it first.

**An abstract class**, for a contract whose implementation is chosen elsewhere.
It exists at runtime, so it works as a token. Always bind it to an
implementation. If you do not, the container constructs the abstract class
itself, like any unbound class (see
[The self-binding hole](#the-self-binding-hole)). `Logger` and `RequestContext` in
`@dunx/core` are abstract classes.

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

A `Token<T>` cannot be a constructor parameter type, so the only way to read it
is `inject()`. Prefer a class when you can write one.

### The self-binding hole

Every class is injectable by default, which is convenient and has one sharp edge
worth publishing.

`abstract` does not exist at runtime. If you inject an abstract class and never
bind it, the container constructs it anyway and you get an object with no
implementation, with no error. TypeScript rejects an abstract class listed bare in
`providers`, but it does not catch the `inject()` call.

The same shape appears with options classes: a class whose constructor arguments
are all optional resolves successfully when nothing bound it, so
`app.get(QueueOptions)` on a container with no `QueueModule` returns defaults
rather than throwing. Any presence check for a class-shaped token has that hole.

A self-bind lands in **the scope that asked for it first** rather than in a global
pool, and from then on the class belongs to that module. A second module injecting
the same unlisted class is a boot error: the class is now declared by the first
module, which does not export it. List a class shared across modules in the one
that owns it, and export it.

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
same instance. There is no request or transient scope; per-request state travels
as an argument or through `RequestContext`.
[Lifecycle](./07-lifecycle.md) covers the lifetime, boot order and error
propagation.

## Eager resolution

`AppFactory.create()` instantiates every declared binding and awaits every async
factory before it returns, so wiring errors surface at boot rather than at first
request. There is no separate `init()`.

Two kinds of provider are built on first use instead: a class that no module
declared, and the default `Logger` and `RequestContext`. If nothing asks for one,
it is never constructed and never gets `onInit` or `onShutdown`.

That is also what keeps `inject()` synchronous: by the time any constructor runs,
every async provider has resolved.

The container only finds `inject()` calls by running field initializers, so it
cannot sort the graph ahead of time. When a constructor reaches an async factory
that has not resolved yet, the container stops that construction, awaits the
factory, and constructs the class again. Each factory runs once, and each retry
resolves at least one more async provider.

**The rule that follows: field initializers must stay pure wiring.** A constructor
aborted by that retry runs its already-evaluated field initializers again. An
`inject()` call is fine. Incrementing a counter, pushing to a shared array or
opening a socket in a field initializer is not.

## Lifecycle hooks

Four hooks, all structural: `OnBeforeInit`, `OnInit`, `OnBeforeShutdown` and
`OnShutdown`. Implement the method and the container finds it; the `implements`
clause only makes TypeScript check the signature. Each may return a promise, and
each is awaited.

Anything that must exist before a constructor runs belongs in a `useFactory`,
because factories are awaited during resolution. `onInit` runs after the _entire_
graph is constructed, in dependency order, so it is the place for work that
depends on peers being ready. `onShutdown` runs in reverse construction order.
When each hook runs, and what a throwing one does: [Lifecycle](./07-lifecycle.md).

## Cycles

A real dependency cycle is a boot error, `CircularDependencyError`, carrying the
full path on `error.cycle`:

```
Circular dependency: Alpha -> Beta -> Alpha
```

A circular _import_ between two files is fine, because the dependency record is a
thunk. A circular _dependency_, where two providers each need the other
constructed first, is not. Break it by extracting the shared piece into a third
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

A test stubbing `Logger` does not need to know how many modules bind it. You
cannot limit an override to one module. If two modules bind a token differently
and you want to replace only one, resolve through the module you care about.

The replaced provider is never instantiated: its `useFactory` never runs and its
`onInit` never fires. Overriding a database therefore never opens a real
connection.

An override naming a **non-class** token nobody binds is an error rather than a
silent no-op:

```
Nothing to override for DSN: no module in the graph binds it, and it is not a class,
so nothing self-binds it either. An override replaces a binding - it cannot add one,
because a token nobody bound is a token nothing under test resolves.
```

An override for a **class** nobody bound is accepted. An unbound class would be
registered on first use anyway, and the override takes the place of that
registration. Abstract classes count as classes here (the check is
`typeof token === 'function'`).

`Logger` and `RequestContext` are substituted too, so overriding `Logger` works in
an app that binds none. `@dunx/testing` ships a `RecordingLogger` for exactly
that.

## Next

[Modules](./04-modules.md) for how providers are grouped, ordered and configured.
[Controllers](./05-controllers.md) for the providers that have routes on them.
