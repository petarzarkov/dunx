# __DUNX_APP_NAME__

A [dunx](https://github.com/petarzarkov/dunx) application.

```bash
bun install
bun run start     # http://localhost:3000/greetings
bun test
```

## What is here

| File                        | Why                                                             |
| --------------------------- | --------------------------------------------------------------- |
| `src/main.ts`               | Builds the container, discovers routes, starts `Bun.serve`      |
| `src/app.module.ts`         | The root module - `controllers` get routes, `providers` do not  |
| `src/greetings.service.ts`  | A provider, injected by constructor type with no annotation     |
| `src/greetings.controller.ts` | Routes, returning plain objects                               |
| `src/app.test.ts`           | The whole app behind a real server on port 0                    |
| `bunfig.toml`               | The preload line that makes constructor injection work          |

## The one line that matters

```toml
preload = ["@dunx/transform/preload"]
```

`@dunx/transform` reads each class's constructor parameter types when the file
loads and records them, so the container can resolve them before calling `new`.
Without it, providers are constructed with no arguments and boot fails saying so -
it is not a silent `undefined`.

That is also why there is no `@Injectable()` and no `@Inject()`. Being listed in a
module's `providers` is what makes a class injectable, and TC39 standard decorators
have no parameter decorators, so `@Inject()` does not exist.

## Next

- Add validation: give a route a schema and the body arrives typed and coerced.
  Any Standard Schema validator works - zod, Valibot, ArkType.
- Add a database: `@dunx/infra/db` is drizzle over `bun:sqlite` and `Bun.SQL`.
- Serve an OpenAPI document and a page that can call your routes: `@dunx/openapi`.

The [examples](https://github.com/petarzarkov/dunx/tree/main/examples) go in that
order - `minimal`, then `databases` and `testing`, then `full`.
