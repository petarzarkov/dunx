# @dunx/transform

Load-time transform that lets the dunx container use constructor injection.

```ts
export class UsersService {
  constructor(private readonly repo: UsersRepository) {}
}
```

No `@Injectable`, no `@Inject`, no `reflect-metadata`, no `experimentalDecorators`.
The [Providers guide](../../docs/guide/03-providers.md) is canonical.

## Install

```bash
bun add @dunx/transform
```

## Setup

```toml
# bunfig.toml
preload = ["@dunx/transform/preload"]

[test]
preload = ["@dunx/transform/preload"]
```

Or with no config file at all:

```bash
bun --preload @dunx/transform/preload src/main.ts
```

For a production build, pass the plugin to `Bun.build`:

```ts
import { depsPlugin } from '@dunx/transform';

await Bun.build({ entrypoints: ['src/main.ts'], plugins: [depsPlugin] });
```

## Publishing a package

The preload skips `node_modules`, so a package on npm has to carry its own
records or nothing can inject its classes. `@dunx/transform/build` does that
build, reading entrypoints from your `exports` and `bin`:

```ts
// build.ts
import { buildPackage } from '@dunx/transform/build';

await buildPackage();
```

It assumes sources under `src/`, output to `dist/`, and one `tsconfig.json` at
the package root. Declarations come from `typescript`, an optional peer, because
Bun emits none. The full walkthrough is in
[the publishing guide](../../docs/guide/30-publishing-a-package.md).

## What it does

It parses each file with `oxc-parser` and reads every class declaration's
constructor parameter types. Then it appends one statement per class:

```ts
Object.defineProperty(UsersService, Symbol.for('dunx.deps'), {
  value: () => [UsersRepository],
});
```

`@dunx/core` reads that record and resolves the arguments before calling `new`.

The record is a **thunk**, a function that returns the parameter types. The
container calls it when it resolves the class, not when the file loads. So a
dependency declared later in the file, or reached through a circular import, needs
no `forwardRef`.

Only the appended statement is added. Every other byte of the original source is
preserved, so comments, formatting, and the line numbers in stack traces are
unchanged.

## Parameters it will not guess

A parameter whose type names nothing that exists at runtime is recorded as
`unresolved`, together with its original source text. The container then throws
at boot:

```
UsersService cannot be constructed: parameter 2 (private readonly cfg: AppConfig)
names nothing that exists at runtime, so there is no token to resolve. Replace
the type with an abstract class, or bind it with token() and read it with
inject(TOKEN) in a field initializer.
```

This error covers a type-only import, an inline `type` specifier, a local
`interface` or type alias, a class type parameter, a primitive and a union. For a
type-only import, the error tells you to use a value import instead. For the rest,
use an abstract class or a `token()`. A token has no type to put on a parameter,
so read it with `inject(TOKEN)` in a field initializer.

Class **expressions** are skipped: `const X = class Inner {}` binds `Inner` only
inside the class body, so a statement appended after it could not reference the name.

## If you forget to register it

The container checks `ctor.length` against the recorded dependencies, so a class the
plugin never saw is a boot error rather than a set of `undefined` fields:

```
UsersController declares 1 constructor parameter(s) but no dependencies were
recorded for it, so @dunx/transform did not transform UsersController.
```
