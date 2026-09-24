# @dunx/core

The dependency injection container, modules, lifecycle, configuration, and the
`Logger` and `RequestContext` contracts for
[dunx](https://github.com/petarzarkov/dunx).

**Zero dependencies.** That is a constraint rather than a coincidence: it lets
`@dunx/http` inject a logger without pulling in a logging implementation
behind it.

## Install

```bash
bun add @dunx/core @dunx/transform
```

## Usage

Constructor injection, with no annotation of any kind:

```ts
import { AppFactory, Module } from '@dunx/core';

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
| Configuration | `ConfigModule.forRoot`, a `validate` function or a `schema` | [Configuration](../../docs/guide/12-configuration.md)  |
| Logging       | The `Logger` contract and `ConsoleLogger`                    | [Logging](../../docs/guide/13-logging.md)              |
| Events        | `EventBus`, `AppEvent`, `@OnEvent`, `EventRegistry`          | [Events](../../docs/guide/27-events.md)                |
| Stats         | `Durations`, `Counter`, `Gauge`, `RuntimeStats`, `EventLoopLag` | [Metrics](../../docs/guide/24-metrics.md)           |
| Resilience    | `ResiliencePolicy`, timeout, retry, backoff, jitter, fallback | [Resilience](../../docs/guide/26-resilience.md)       |
| Tracing       | The `Tracer` contract, `NoopTracer`, and `OtelModule` on `/otel` | [Tracing](../../docs/guide/31-tracing.md)          |

## Subpaths

| Subpath           | Contains                                                                  |
| ----------------- | ------------------------------------------------------------------------- |
| `@dunx/core`      | Everything above. Never imports `@opentelemetry/api`                      |
| `@dunx/core/otel` | `OtelModule` and `OtelTracer`, on the optional peer `@opentelemetry/api` |

```bash
bun add @opentelemetry/api   # only for @dunx/core/otel, ^1.4.0
```

`@opentelemetry/api` is a peer so the app's SDK and dunx share one copy: a
provider registered through an older copy drops spans started through a newer
one. dunx ships no SDK and no exporter; register your own before `create`.

## Notes

- **The container is scoped.** Every module reference is a scope holding what it
  declares. `exports` is its public surface, and `global: true` publishes
  those exports app-wide. An absent `exports` exports nothing.
- A parameter whose type erases - an interface, a primitive, a union, a
  type-only import - is a **boot error naming that parameter**, not a silent
  `undefined`. A parameter with a default keeps its default instead.
- Three contracts are always resolvable: `Logger` defaults to `ConsoleLogger`,
  `RequestContext` to `AsyncRequestContext`, backed by `AsyncLocalStorage`, and
  `Tracer` to `NoopTracer`. This lets `@dunx/http` log every request in an app
  that imported no logging module. A module binding any of them wins.
- `ConsoleLogger` batches `info` and below into one write per event-loop turn;
  `warn` and above are never batched and flush what is queued behind them.
- The stats primitives are `node:perf_hooks` and `process`, both platform
  builtins, so this package still has zero dependencies.
- **`Durations` closes four edges the native histogram has**, each of which can
  otherwise reach a payload: `record(0)` throws `ERR_OUT_OF_RANGE`, an empty
  histogram reports a `min` of 9223372036854776000 and a `mean` of `NaN`, its
  `percentiles` is a `Map` of `bigint` that `JSON.stringify` turns into `{}` with
  no error, and `mean` costs 42.2 us. So an observation under 1 clamps, an empty
  snapshot is `{ count: 0 }`, percentiles are read with `percentile(n)` and come
  back as numbers, and `mean` is not offered.

## License

MIT
