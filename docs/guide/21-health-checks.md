# Health checks

`HealthModule` mounts two routes and gives an orchestrator something to read.

```ts
import {
  DatabaseIndicator,
  HealthModule,
  MemoryIndicator,
  MemoryOptions,
  RedisIndicator,
} from '@dunx/http';

@Module({
  imports: [
    HealthModule.forRootAsync({
      useFactory: (db: DbConnection, redis: RedisConnection) => ({
        readiness: [new DatabaseIndicator(db), new RedisIndicator(redis)],
        liveness: [
          new MemoryIndicator(
            new MemoryOptions({ maxRssBytes: 512 * 1024 ** 2 }),
          ),
        ],
        drainDelayMs: 15_000,
      }),
      inject: [DbConnection, RedisConnection],
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

export class BrokerIndicator extends HealthIndicator {
  readonly name = 'broker';

  async check(): Promise<ProbeResult> {
    const started = performance.now();
    await this.broker.ping();
    return {
      state: 'up',
      detail: `${Math.round(performance.now() - started)} ms`,
    };
  }
}
```

Throwing is how a check reports `down`. The registry never lets one throw into a
response.

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
