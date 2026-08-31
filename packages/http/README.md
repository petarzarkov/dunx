# @dunx/http

`Bun.serve` adapter for [dunx](https://github.com/petarzarkov/dunx): class-based
controllers, **WebSocket gateways**, and standard decorators. There is no
JavaScript router - Bun's native `routes` does path params and per-method
dispatch in Zig.

`Bun.serve` takes `routes` and `websocket` in one call, so both live here: one
`listen()`, one server, one port. No `express`, no `ws`, no `socket.io`.

## Install

```bash
bun add @dunx/http @dunx/core
```

## Usage

```ts
import { inject, Module } from '@dunx/core';
import { Controller, Get, HttpFactory, Post, type Input } from '@dunx/http';
import { z } from 'zod'; // or Valibot, or ArkType, or none at all

const createUser = { body: z.object({ name: z.string() }) } as const;
const oneUser = { params: z.object({ id: z.coerce.number() }) } as const;

@Controller('users')
export class UsersController {
  readonly #users = inject(UsersService);

  @Get('/')
  list() {
    return this.#users.findAll(); // plain values become Response.json()
  }

  @Get('/:id', oneUser)
  one(input: Input<typeof oneUser>) {
    return this.#users.find(input.params.id); // a number, already validated
  }

  @Post('/', createUser)
  create(input: Input<typeof createUser>) {
    return this.#users.create(input.body.name); // 201, no Response.json()
  }
}

@Module({ controllers: [UsersController], providers: [UsersService] })
export class UsersModule {}

const app = await HttpFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen(3000);
```

## What is here

The guide is canonical for every row; this table is the index.

| Area                    | What it covers                                              | Guide                                                             |
| ----------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| Controllers and routing | Verb decorators, path params, prefixes, status codes        | [Controllers](../../docs/guide/05-controllers.md)                 |
| Typed input             | `body`, `query`, `params` over Standard Schema              | [Validation](../../docs/guide/06-validation.md)                   |
| Middleware and guards   | One extension point, `@UseGuards`, `@Roles`, `@Public`      | [Middleware and guards](../../docs/guide/08-middleware-and-guards.md) |
| WebSocket gateways      | `@Gateway`, handlers, `PubSub`, multi-node relay            | [WebSockets](../../docs/guide/09-websockets.md)                   |
| Request logging         | One structured entry per request, on by default             | [Logging](../../docs/guide/13-logging.md)                         |
| Health and draining     | `/health/live`, `/health/ready`, readiness during a rollout | [Health checks](../../docs/guide/20-health-checks.md)             |
| Throttling              | `@Throttle`, `@SkipThrottle`, memory and Redis counters     | [Middleware and guards](../../docs/guide/08-middleware-and-guards.md) |
| Static files            | `Bun.file` behind a mount, with a cache policy              | [Deployment](../../docs/guide/19-deployment.md)                   |
| Compression             | zstd and gzip on Bun's own compressors                      | [Deployment](../../docs/guide/19-deployment.md)                   |

## Subpaths

| Subpath                | Contains                                                          |
| ---------------------- | ----------------------------------------------------------------- |
| `@dunx/http`           | Everything above                                                  |
| `@dunx/http/client`    | The outbound half: `HttpService`, retry with backoff, `HttpModule` |
| `@dunx/http/internal`  | The framework's own plumbing. No stability promise                |

`@dunx/http/internal` holds route-table construction, the middleware fold, the
relay codec and the discovery readers - what `@dunx/dashboard`, `@dunx/mcp` and
`@dunx/openapi` call and an app does not. It is the only place they are exported
from, and it may change in any release.

## Notes

- Routes are discovered at boot by walking each controller's prototype chain, so
  an abstract base controller's `@Get` methods are inherited by every subclass.
- A duplicate method and path throws at boot naming both handlers. Bun would
  otherwise silently keep one.
- Handlers may return a `Response`, any JSON-serialisable value, or `undefined`
  for a 204.
- Schemas, parsers and the status resolve at boot into the same closure the
  middleware chain folds into. A request reads no metadata and does no lookup.

## License

MIT
