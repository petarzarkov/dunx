# @dunx/http

Class-based controllers and **WebSocket gateways** for
[dunx](https://github.com/petarzarkov/dunx), served by `Bun.serve` with standard
decorators. There is no JavaScript router: Bun's built-in `routes` handles path
parameters and HTTP methods natively.

HTTP and WebSockets share one `listen()`, one server and one port, without
`express`, `ws` or `socket.io`.

## Install

```bash
bun add @dunx/http @dunx/core @dunx/transform
```

Add `preload = ["@dunx/transform/preload"]` to `bunfig.toml` for constructor
injection, once at the top level and once under `[test]`.

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

Each row links to the guide that covers it.

| Area                    | What it covers                                              | Guide                                                             |
| ----------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| Controllers and routing | Verb decorators, path params, prefixes, status codes        | [Controllers](../../docs/guide/05-controllers.md)                 |
| Typed input             | `body`, `query`, `params` over Standard Schema              | [Validation](../../docs/guide/06-validation.md)                   |
| Middleware and guards   | One extension point, `@UseGuards`, `@Roles`, `@Public`      | [Middleware and guards](../../docs/guide/08-middleware-and-guards.md) |
| WebSocket gateways      | `@Gateway`, handlers, `PubSub`, multi-node relay            | [WebSockets](../../docs/guide/09-websockets.md)                   |
| Server-sent events      | `@Sse`, `SseStream`, framing, heartbeats, `Last-Event-ID`   | [Controllers](../../docs/guide/05-controllers.md)                 |
| Request logging         | One structured entry per request, on by default             | [Logging](../../docs/guide/13-logging.md)                         |
| Trace context           | W3C `traceparent` adopted and propagated, on by default     | [Logging](../../docs/guide/13-logging.md)                         |
| Spans                   | A SERVER span per request and a CLIENT span per call, with `OtelModule` | [Tracing](../../docs/guide/31-tracing.md)             |
| Metrics                 | Per-route counts and timings, off by default                | [Metrics](../../docs/guide/24-metrics.md)                         |
| Health and draining     | `/health/live`, `/health/ready`, readiness during a rollout | [Health checks](../../docs/guide/22-health-checks.md)             |
| Throttling              | `@Throttle`, `@SkipThrottle`, memory and Redis counters     | [Middleware and guards](../../docs/guide/08-middleware-and-guards.md) |
| Outbound resilience     | `HttpRetryClassifier`: which statuses retry, and `Retry-After` | [Resilience](../../docs/guide/26-resilience.md)                |
| Static files            | `Bun.file` behind a mount, with a cache policy              | [Deployment](../../docs/guide/21-deployment.md)                   |
| Compression             | zstd and gzip on Bun's own compressors                      | [Deployment](../../docs/guide/21-deployment.md)                   |
| RPC                     | protobuf over Connect and gRPC-Web, as middleware           | [RPC](../../docs/guide/28-rpc.md)                                 |

## Subpaths

| Subpath                | Contains                                                          |
| ---------------------- | ----------------------------------------------------------------- |
| `@dunx/http`           | Everything above                                                  |
| `@dunx/http/client`    | The outbound half: `HttpService`, retry with backoff, `HttpModule` |
| `@dunx/http/connect`   | protobuf services over Connect and gRPC-Web, mounted as middleware |
| `@dunx/http/internal`  | The framework's own plumbing. No stability promise                |

`@dunx/http/internal` is for dunx's own packages: `@dunx/dashboard`, `@dunx/mcp`
and `@dunx/openapi`. Do not import it from an app, since it can change in any
release.

## Notes

- Routes are found at boot, including those inherited from a base class, so a
  subclass of an abstract controller serves its parent's `@Get` methods too.
- Two handlers for the same method and path fail at boot, and the error names
  both. Bun would otherwise keep one of them without saying so.
- A handler can return a `Response`, any JSON-serialisable value, or `undefined`
  for a 204.
- `Authorize` and `gate()` protect admin pages. They receive the raw request and
  answer 404 when access is refused, or send a `Response` you return as it is,
  such as a sign-in page. `@dunx/dashboard` and `@dunx/openapi` both accept one,
  so you write the access rule once.
- Schemas, parsers and status codes are worked out once at boot. Handling a
  request does no metadata lookups.
- Every request joins the caller's W3C trace (`traceparent`). Its log lines carry
  `traceId`, `spanId`, `parentSpanId` and `traceFlags`, and the response carries
  a `traceresponse` header. `requestLogging: { trace: false }` turns both off.
  `{ traceResponse: false }` keeps the trace fields and drops only the header,
  which saves about 500 ns a request. There is no separate correlation id.
- `metrics: true` adds request counts and a latency histogram per route, for
  about 35 ns a request.
- `@dunx/http/connect` serves Connect and gRPC-Web, but not native gRPC. Native
  gRPC sends its status in an HTTP trailer, which `Bun.serve` cannot send, so a
  request with `content-type: application/grpc` gets a 415 explaining why.
  `@connectrpc/connect` and `@bufbuild/protobuf` are optional peer dependencies,
  and you keep your own `.proto` toolchain. `ThrottleGuard` applies to RPC paths
  as well.

## License

MIT
