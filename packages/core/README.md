# @dunx/core

The dependency injection container, modules, lifecycle, configuration, and the
`Logger` and `RequestContext` contracts for
[dunx](https://github.com/petarzarkov/dunx).

**Zero dependencies.** That is a constraint rather than a coincidence: it lets
`@dunx/http` inject a logger without pulling in a logging implementation
behind it.

## Install

```bash
bun add @dunx/core
```

## Usage

Constructor injection, with no annotation of any kind:

```ts
import { Module } from '@dunx/core';

export class UsersService {
  constructor(private readonly repo: UsersRepository) {}
}

@Module({
  providers: [UsersRepository, UsersService],
  exports: [UsersService], // absent means nothing is exported
})
export class UsersModule {}

const app = await AppFactory.create(AppModule);
```

No `@Injectable`, no `@Inject`, no `reflect-metadata`, no
`experimentalDecorators`. `@dunx/transform` reads each class's constructor
parameter types at load time, so an app opts in with one line of `bunfig.toml`:

```toml
preload = ["@dunx/transform/preload"]

[test]
preload = ["@dunx/transform/preload"]
```

## What is here

| Area          | What it covers                                              | Guide                                                  |
| ------------- | ------------------------------------------------------------ | ------------------------------------------------------ |
| Providers     | Constructor injection, `provide()`, `token()`, `inject()`    | [Providers](../../docs/guide/03-providers.md)          |
| Modules       | Scoping, `imports`, `exports`, `global`, `forRoot`           | [Modules](../../docs/guide/04-modules.md)              |
| Lifecycle     | `onInit`, `onBeforeShutdown`, `onShutdown`, signal handlers  | [Lifecycle](../../docs/guide/07-lifecycle.md)          |
| Configuration | `ConfigModule.forRoot({ validate })`, one validation function | [Configuration](../../docs/guide/12-configuration.md)  |
| Logging       | The `Logger` contract and `ConsoleLogger`                    | [Logging](../../docs/guide/13-logging.md)              |

## Notes

- **The container is scoped.** Every module reference is a scope holding what it
  declares. `exports` is its public surface, and `global: true` publishes
  those exports app-wide. An absent `exports` exports nothing.
- A parameter whose type erases - an interface, a primitive, a union, a
  type-only import - is a **boot error naming that parameter**, not a silent
  `undefined`. A parameter with a default keeps its default instead.
- Two contracts are always resolvable: `Logger` defaults to `ConsoleLogger`, and
  `RequestContext` to `AsyncLocalStorage`. This lets `@dunx/http` log every
  request in an app that imported no logging module. A module binding either
  one wins.
- `ConsoleLogger` batches `info` and below into one write per event-loop turn;
  `warn` and above are never batched and flush what is queued behind them.

## License

MIT
