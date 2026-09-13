# Health checks

`HealthModule` mounts two routes and gives an orchestrator something to read.

```ts
import {
  AmqpIndicator,
  DatabaseIndicator,
  HealthModule,
  MemoryIndicator,
  MemoryOptions,
  RedisIndicator,
} from '@dunx/http';

@Module({
  imports: [
    HealthModule.forRootAsync({
      useFactory: (
        db: DbConnection,
        redis: RedisConnection,
        amqp: AmqpConnection,
      ) => ({
        readiness: [
          new DatabaseIndicator(db),
          new RedisIndicator(redis),
          new AmqpIndicator(amqp),
        ],
        liveness: [
          new MemoryIndicator(
            new MemoryOptions({ maxRssBytes: 512 * 1024 ** 2 }),
          ),
        ],
        drainDelayMs: 15_000,
      }),
      inject: [DbConnection, RedisConnection, AmqpConnection],
    }),
  ],
})
export class AppModule {}
```

`GET /health/live` answers "is this process working". `GET /health/ready` answers
"should it receive traffic". `up` is `200` and anything else is `503`.

Both are `@Public()`: a probe carries no credentials.

Both are documented, under a `Health` tag, with the report shape as
`components/schemas/HealthReport` on both the 200 and the 503. `documented: false`
mounts a variant carrying `@ApiHidden()`, which serves the same two routes and
leaves them out of the OpenAPI document.

`HEALTH_REPORT_SCHEMA` is exported, so an app answering on its own paths can
reference the same definition.

## The report

```json
{
  "status": "up",
  "draining": false,
  "uptimeMs": 41233,
  "checks": [{ "name": "database", "state": "up", "critical": true, "ms": 1 }]
}
```

One list, so finding the unhappy check is one place to look.

Checks run concurrently, each bounded by `timeoutMs` (default 2000), so the report
costs the slowest check rather than their sum.

## Three states

A check that throws is `down`, carrying its message. A check that outruns its
budget is `unknown`.

The difference matters. A probe that did not answer has told you nothing, which
is not the same as telling you it is broken.

`unknown` on a critical check fails readiness. On a non-critical one it does not.

## Critical and not

`critical` defaults to `true`. A failure sheds traffic.

`MemoryIndicator` and `DiskIndicator` ship as `critical: false`. A disk at 91
percent is worth seeing on the page. Pulling the pod out of rotation does not
make it emptier, since no other pod's disk is either.

A memory ceiling belongs on `liveness`, where the orchestrator restarts the
process rather than routing around it.

## What ships

| Indicator           | Takes                                   | Up when                                   |
| ------------------- | --------------------------------------- | ----------------------------------------- |
| `RedisIndicator`    | `PingProbe`, which `RedisConnection` is | `PING` answers                            |
| `DatabaseIndicator` | `QueryProbe`, which `DbConnection` is   | a round trip completes                    |
| `AmqpIndicator`     | `QueryProbe`, which `AmqpConnection` is | the broker connection is up and unblocked |
| `StorageIndicator`  | `StorageProbe`, which `Storage` is      | the store answers                         |
| `MemoryIndicator`   | `MemoryOptions`                         | rss is under the ceiling                  |
| `DiskIndicator`     | `DiskOptions`                           | the filesystem is under the used fraction |

Each probe is a narrow abstract class holding the one or two members the check
calls, so the connection classes in `@dunx/infra` satisfy them as written and a
stub in a test is an object literal.

### RabbitMQ

`AmqpIndicator` takes `AmqpConnection` from `@dunx/infra/amqp`.

```ts
HealthModule.forRootAsync({
  useFactory: (amqp: AmqpConnection) => ({
    readiness: [new AmqpIndicator(amqp)],
  }),
  inject: [AmqpConnection],
});
```

The connection opens on first use, so a process that neither publishes nor
consumes holds no socket until something asks for one. Registering this indicator
asks: the first probe opens the connection and waits up to `readyTimeoutMs` for
it to come up.

Every probe after that answers from what the socket has already reported.
Established and unblocked is `up` with the latency. A socket that has failed and
not recovered is `down` carrying its own message, such as
`connect ECONNREFUSED 127.0.0.1:5672`, without waiting the window out again.

A blocked connection counts as down. RabbitMQ blocks a publisher when the broker
is out of memory or disk, and a process whose publishes are piling up in its own
heap should stop being sent work.

### Object storage

`StorageIndicator` takes `Storage` from `@dunx/infra/files`, so it measures
whichever backend an app configured.

```ts
new StorageIndicator(storage);
new StorageIndicator(storage, new StorageProbeOptions({ key: 'ops/probe' }));
```

It asks whether one key exists: a `HEAD` against S3, a `stat` on a local root.
Nothing has to be at that key. A store that answers is `up`, and a store that
throws is `down` with its message, which covers expired credentials and a bucket
that is gone.

`DiskIndicator` answers a different question. It measures how full a local
filesystem is, and an app on `S3Storage` has an idle local disk whatever the
bucket is doing. Run both when uploads land on a volume.

## Draining

Readiness starts failing **before** the port closes.

`Readiness` implements [`OnBeforeShutdown`](./07-lifecycle.md), which runs while
the server is still accepting, so the probe can answer "not ready" while the
load balancer can still reach it. Every `onShutdown` hook runs after the server
has stopped, so a probe answering from there answers on a socket that is already
closed.

`drainDelayMs` keeps readiness failing for that long before the socket closes. A
load balancer notices a failing probe on its own schedule: at a 2-second interval
and a 3-failure threshold, traffic can arrive for 6 seconds after the pod has
decided to go. Set it to a few intervals.

Liveness keeps passing throughout. A pod that is shutting down does not need
restarting, and `down` there invites a SIGKILL mid-drain.

## Taking a pod out by hand

A drain does not always start with a signal. A migration needs the same
"stop sending me traffic" behaviour on demand, and `Readiness` is injectable so
a handler can trigger it directly.

```ts
export class MaintenanceController {
  readonly #readiness = inject(Readiness);

  @Post('/pause')
  pause(): void {
    this.#readiness.hold('migrating');
  }

  @Post('/resume')
  resume(): void {
    this.#readiness.release();
  }
}
```

`release()` does not undo a shutdown.

## Your own indicators

Subclass `HealthIndicator`, or hand `HealthOptions` any object with the three
members.

```ts
import { HealthIndicator, type ProbeResult } from '@dunx/http';

export class SearchIndicator extends HealthIndicator {
  readonly name = 'search';

  constructor(private readonly index: SearchIndex) {
    super();
  }

  async check(): Promise<ProbeResult> {
    const documents = await this.index.count();
    return documents > 0
      ? { state: 'up', detail: `${documents} documents` }
      : { state: 'down', detail: 'the index is empty' };
  }
}
```

Throwing is how a check reports `down`. The registry never lets one throw into a
response.

Anything that already answers a `ping()` needs less. `RoundTripIndicator` holds
the body the shipped round trips share, so a subclass is a name:

```ts
export class VectorStoreIndicator extends RoundTripIndicator {
  readonly name = 'vectors';
}
```

`critical` is a member rather than an argument, so an indicator that should
report without shedding traffic is also a subclass:

```ts
export class CacheIndicator extends RedisIndicator {
  override readonly critical = false;
}
```

`DatabaseIndicator` needs a connection with `ping()`, which `DbConnection` from
`@dunx/infra/db` has. A custom connection must implement `ping()` too: the base
throws a message naming what is missing, rather than reporting a database
healthy without having asked it anything.

## No startup probe

The port already answers that question. `create()` finishes every `onInit`
before `listen()` binds, so a refused connection means "not started yet".

## Options

```ts
HealthModule.forRoot({
  liveness: [],
  readiness: [],
  timeoutMs: 2000,
  drainDelayMs: 0,
  routes: true,
  documented: true,
});
```

`routes: false` binds `HealthRegistry` and `Readiness` and mounts nothing, for an
app that answers on its own paths.

`documented: false` mounts the routes and hides them from `@dunx/openapi`.
