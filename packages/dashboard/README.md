# @dunx/dashboard

One page over a running [dunx](https://github.com/petarzarkov/dunx) app: the
routes it serves, the container it built, the gateways it upgrades, Redis, the
config keys and the process itself, **with bull-board mounted for the queues**.

Every panel reads data dunx already computes, so the page is cheap.

## Install

```bash
bun add @dunx/dashboard
# for the queues page
bun add @bull-board/api @bull-board/ui @bull-board/bun
```

## Usage

```ts
import { DashboardMiddleware, DashboardModule } from '@dunx/dashboard';
import { JobPublisher } from '@dunx/infra/queue';
import { RedisConnection } from '@dunx/infra/redis';

@Module({
  imports: [
    DashboardModule.forRootAsync({
      imports: [JobsModule, CacheModule],
      inject: [JobPublisher, RedisConnection],
      useFactory: (queues: JobPublisher, redis: RedisConnection) => ({
        path: '/api/_dunx',
        queues,
        redis,
        authorize: (req) => isOperator(req),
      }),
    }),
  ],
})
export class OpsModule {}

const app = await HttpFactory.create(AppModule);
app.use(DashboardMiddleware); // first, ahead of any session guard
```

## The panels

Six panels, each with a JSON sibling under `{path}/api/*`, so `curl` is a real
way to read this on a box with no browser. The queues page is bull-board's.

| Panel     | Shows                                                      |
| --------- | ------------------------------------------------------------ |
| Routes    | Every route, its guards and metadata, linked to `/docs`     |
| Providers | The container graph, by module                              |
| Gateways  | Every WebSocket gateway and its events                      |
| Redis     | Connection state and `INFO`                                 |
| Config    | Keys always, values only where `reveal` says so             |
| Runtime   | The process, its memory and its probes                      |

## Three things that are decisions

- **`authorize` has no default**, and leaving it out serves the page to anyone
  who can reach the port. Omitting it logs a warning naming the mount at boot.
- **A rejected request gets 404, not 403.** Register the middleware **ahead of
  any session guard**: a guard running first answers 401 and tells a prober the
  mount exists. `authorize` takes the raw `Request` so it can be self-sufficient.
- **Config values are redacted by default.** `reveal` is an opt-in allow-list; a
  deny-list of the usual suspects leaks the first key nobody thought of.

## Notes

- It depends on `@dunx/infra` and `bullmq` not at all. `QueueSource` and
  `RedisProbe` restate structurally what `JobPublisher` and `RedisConnection`
  already are, so `queues: publisher` is the whole wiring.
- The board is built on the first request for the queues page, never at boot, so
  an app that never opens it holds no broker socket.
- `commands: false` maps onto bull-board's own `readOnlyMode`.

## License

MIT
