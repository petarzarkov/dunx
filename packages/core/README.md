# @dunx/core

The dependency injection container, modules, lifecycle, configuration, and the
`Logger` and `RequestContext` contracts for
[dunx](https://github.com/petarzarkov/dunx).

**No dependencies.** The other dunx packages can inject a `Logger` without
installing a logging library.

## Install

```bash
bun add @dunx/core @dunx/transform
```

## Usage

Constructor injection needs no decorators:

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

You do not need `@Injectable`, `@Inject`, `reflect-metadata` or
`experimentalDecorators`. `@dunx/transform` reads each constructor's parameter
types when the file loads. Turn it on in `bunfig.toml`, once for the app and once
for tests:

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

`@opentelemetry/api` is a peer dependency so that your SDK and dunx use the
same copy. With two copies installed, spans can go missing without an error.
dunx does not include an SDK or an exporter: register your own before calling
`create`.

## Notes

- **Each module is its own scope.** A module can use what it declares and what
  the modules it imports export. List what other modules may use in `exports`;
  leave `exports` out and nothing is shared. `global: true` makes a module's
  exports available everywhere.
- If a constructor parameter's type does not exist at runtime (an interface, a
  primitive, a union or a type-only import), **boot fails with an error naming
  that parameter**. You never get a silent `undefined`. A parameter with a
  default value keeps its default.
- `Logger`, `RequestContext` and `Tracer` can always be injected. The defaults
  are `ConsoleLogger`, `AsyncRequestContext` (on `AsyncLocalStorage`) and
  `NoopTracer`, and a module that binds one replaces the default. `@dunx/http`
  relies on this to log requests in an app with no logging module.
- `ConsoleLogger` collects `info` and lower into one write per event-loop turn.
  `warn` and higher are written at once, along with anything waiting before them.
- The stats classes use only `node:perf_hooks` and `process`, so the package
  still has no dependencies.
- **`Durations` fixes four problems with Node's native histogram:**

  | Native histogram                                                  | `Durations`                       |
  | ----------------------------------------------------------------- | --------------------------------- |
  | `record(0)` throws `ERR_OUT_OF_RANGE`                             | A value under 1 is recorded as 1  |
  | An empty histogram reports `min` 9223372036854776000, `mean` `NaN` | An empty snapshot is `{ count: 0 }` |
  | `percentiles` is a `Map` of `bigint`, which serialises to `{}`    | `percentile(n)` returns a number  |
  | `mean` costs 42.2 us                                              | No `mean`                         |

## License

MIT
