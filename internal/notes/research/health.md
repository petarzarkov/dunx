# Health and readiness

## Verdict

**Build.** Owning package `@dunx/http`, main entry (`.`), no new subpath. Two
supporting additions elsewhere: an `OnDrain` lifecycle interface in `@dunx/core`,
and `ping()` on `DbConnection` in `@dunx/infra/db`.

Not a new workspace, and the argument is not only "the bias is toward fewer".

- `@dunx/http` is one of the three packages `docs/ROADMAP.md` reserves the work for
  until an external issue lands, so this is inside the priority, not beside it.
- The endpoints are `@Controller` routes, and everything they need is already in
  `@dunx/http`: `@Public()`, `@ApiHidden()`, `RequestLoggingOptions.ignorePrefix`,
  `setGlobalPrefix`, the `Response`-passthrough at `server/routes.ts:59`, and
  `HttpApplication.shutdown()`, which is the only place a readiness flip can be
  sequenced ahead of `server.stop()`.
- It adds no dependency. A `@dunx/health` would need `@dunx/core` and `@dunx/http`
  as peers to do anything, so it buys a third manifest, a third `dist/`, a third
  lockstep version and a build-order edge in exchange for nothing.
- The indicators reach db, Redis and queues **structurally**, the way
  `@dunx/dashboard`'s `contracts.ts` and `@dunx/auth`'s `DrizzleSource` do, so the
  "`@dunx/infra` must not depend on the web layer" constraint is untouched: the
  dependency runs http to nothing and an app passes its connection in.

**One Rule 2 deletion is part of this, not optional.** `packages/dashboard/src/contracts.ts`
already declares `ProbeState`, `ProbeResult`, `DashboardProbe` and `RedisProbe`, and
`@dunx/dashboard` peer-depends on `@dunx/http`, so `@dunx/http` is the lowest common
owner. Those move down, the dashboard imports them, and `DashboardOptions.probes` then
takes the same indicator objects `HealthModule` takes.

## What Bun gives us

Bun 1.3.14 (`bun --version` -> `1.3.14`). Probes in `<SCRATCH>/probes/`.

**Graceful drain is native.** `server.stop()` returns a Promise, refuses the next
connection in the tick it is called, and resolves when the last in-flight request
finished. `pendingRequests` is a live counter.

```
$ bun probes/drain.ts
pendingRequests mid = 1   typeof server.stop() -> Promise
new request during drain -> threw: Unable to connect. Is the computer able to access the url?
in-flight slow request -> slow done after 256ms;  stop() resolved after 256 ms
$ bun probes/pending2.ts
server.pendingRequests  26.1 ns/call     server.pendingWebSockets  40.4 ns/call
```

**Memory: `process.memoryUsage()` is the whole answer, `bun:jsc` is not.**

```
$ bun probes/memory.ts
process.memoryUsage() = {"rss":33095680,"heapTotal":559104,"heapUsed":175406,"external":11886,"arrayBuffers":0}
process.memoryUsage.rss() = 33423360   constrainedMemory = 16606474240   availableMemory = 9310953472
$ bun probes/memcost.ts
process.memoryUsage()              5.960 us/call  (n=10000)
process.constrainedMemory()        0.109 us/call  (n=10000)
process.availableMemory()          7.481 us/call  (n=10000)
jsc.memoryUsage()                  7.917 us/call  (n=10000)
jsc.heapSize()                     1.546 us/call  (n=10000)
jsc.percentAvailableMemoryInUse()  0.569 us/call  (n=1000)   -> returns null
jsc.heapStats()                 2203.141 us/call  (n=200)
```

`jsc.heapStats()` costs **2.2 ms**: it walks every object and appends a full
mimalloc dump (`objectTypeCounts`, 74 `malloc_bins`, 74 `page_bins`). Unusable in a
probe. `Bun.unsafe` holds nothing relevant: `arrayBufferToString,
gcAggressionLevel, mimallocDump` (`bun probes/unsafe.ts`).

**Disk: Bun has no API for it.** `node:fs.statfs` does, and nothing else does.
`Bun.file().stat()` is per-file; its `blocks` is the file's own and there is no
`bsize` or `bavail`.

```
$ bun probes/disk.ts
typeof fs.statfs = function  statfsSync = function  fs/promises.statfs = function
statfs("/") = {"type":61267,"bsize":4096,"blocks":263940717,"bfree":195380238,"bavail":181954370,"files":67108864,"ffree":63903509}
Bun.file().stat() has any fs-space field? bsize/blocks/bavail: false true false
$ bun probes/diskcost.ts
statfsSync('/')  1.852 us/call        await statfs('/') 167.631 us/call
```

The async form costs 90x the sync one and is still correct: 167 us on the threadpool
never blocks the event loop, and `statfsSync` on a stalled network mount blocks it
for the full RPC timeout.

**What Bun does not have.** No disk-space API. No cgroup-aware memory figure this host
could confirm: `/sys/fs/cgroup/memory.max` is absent and `process.constrainedMemory()`
returned exactly `os.totalmem()` (`bun probes/cgroup.ts`), so whether Bun reads a
container limit is **unverified**. And no way to keep accepting while signalling
not-ready, so the Kubernetes window where readiness fails while the pod still serves
has to come from dunx delaying the `stop()` call.

**dunx cannot express that window today.** `HttpApplication.shutdown()`
(`packages/http/src/server/application.ts:355`) is `server.stop()`, then
`PubSub.close()`, then `app.shutdown()`, so every `OnShutdown` hook runs after the
port is already closed:

```
$ bun probes/order.ts
listening -> Readiness.onShutdown -> fetch during shutdown threw "Unable to
connect. Is the computer able to access the url?" -> shutdown resolved
```

An earlier signal listener does not help. Listeners run in registration order,
synchronously, and each returns before the next one's async work
(`bun probes/signals.ts` -> `first (sync) -> second (sync) -> third`). The hook has
to be inside `shutdown()`.

## Library decision

**No library.** Every candidate fails Rule 1's first half, and the second half does
not apply: a health check is `Promise.allSettled` over N pings plus a status code,
not an ORM.

```
$ bun pm view @nestjs/terminus
@nestjs/terminus@11.1.1 | MIT | deps: 2 | versions: 99   .unpackedSize: 0.31 MB
dependencies (2): boxen: 5.1.2, check-disk-space: 3.4.0
$ bun pm view boxen@5.1.2         -> deps: 8 (chalk, camelcase, cli-boxes, type-fest, wrap-ansi, ansi-align, ...)
$ bun pm view check-disk-space    -> "Light multi-platform disk space checker without third party for Node.js"
$ bun pm view @godaddy/terminus   -> deps: 1 (stoppable)
$ bun pm view lightship           -> deps: 4 (delay, fastify, roarr, serialize-error)
$ bun pm view @cloudnative/health -> deps: 0, Published: 2019-12-04
```

`check-disk-space` is a JavaScript reimplementation of `statfs`, which Bun ships.
`boxen` is a terminal box drawer, in a health library, dragging `chalk`. `stoppable`
is a JS graceful-drain shim for `node:http`, which `server.stop()` is natively and
measured above. `lightship` starts its own **Fastify** server on a second port, and
`@cloudnative/health` has not shipped since 2019.

The reference app confirms the shape, not the library. `~/repos/nestjs-template` pins
`@nestjs/terminus@11.1.1` and registers exactly two indicators
(`src/infra/health/health.controller.ts:33-40`): a hand-written `select 1` and
`MemoryHealthIndicator.checkHeap` at 2048 MB. No Redis, no disk, no HTTP indicator, no
readiness endpoint, and nothing ever returns terminus' `shutting_down`.
`TerminusModule.forRoot({ gracefulShutdownTimeoutMs: 10_000 })` sleeps 10 s before
teardown without flipping any flag, because there is no flag to flip. So 0.31 MB and
ten transitive packages bought a heap threshold and a sleep.

Two defects there worth designing against: the probe routes are not excluded from
the global `ThrottlerGuard`, and `e2e/health/health.e2e.ts:21-39` asserts anonymous
`/api/service/up` returns **429** under 30 parallel requests; and
`HEALTH_SHUTDOWN_TIMEOUT_MS` plus four route-name variables exist in its config and
are read nowhere.

## Public API

```ts
// packages/http/src/health/contracts.ts - ProbeState and ProbeResult move down
// from @dunx/dashboard, which re-exports them.
export type ProbeState = 'up' | 'down' | 'unknown';
export interface ProbeResult {
  readonly state: ProbeState;
  readonly detail?: string;
}
/** Abstract class, not interface: it is an injection site and a recorded type.
 *  `critical: false` reports without gating readiness. */
export abstract class HealthIndicator {
  abstract readonly name: string;
  readonly critical: boolean = true;
  abstract check(): Promise<ProbeResult> | ProbeResult;
}
/** PingProbe is satisfied structurally by RedisConnection and by Bun.RedisClient;
 *  QueryProbe by DbConnection, once it grows ping(). */
export abstract class PingProbe {
  abstract ping(message?: string): Promise<string>;
}
export abstract class QueryProbe {
  abstract ping(): Promise<void>;
}

// packages/http/src/health/indicators.ts - options are classes, so they are
// recordable constructor parameter types, like StaticOptions.
export class MemoryOptions {
  readonly maxRssBytes: number; /* ... */
}
export class DiskOptions {
  readonly path: string;
  readonly maxUsedFraction: number; /* ... */
}
export class RedisIndicator extends HealthIndicator {
  readonly name = 'redis';
  constructor(private readonly redis: PingProbe) {
    super();
  }
  async check(): Promise<ProbeResult> {
    /* PING, report ms */
  }
}
/** DatabaseIndicator is the same over QueryProbe. MemoryIndicator is
 *  process.memoryUsage() at 5.96 us and DiskIndicator is await statfs(path) at
 *  167 us off-loop; both `override readonly critical = false`, so neither ever
 *  sheds traffic. */
export class DatabaseIndicator extends HealthIndicator {
  readonly name = 'database';
  constructor(private readonly db: QueryProbe) {
    super();
  }
  async check(): Promise<ProbeResult> {
    /* ping(), report ms */
  }
}

// packages/http/src/health/readiness.ts - injectable, so a handler can pull the
// pod out of rotation for a migration.
export class Readiness implements OnDrain {
  constructor(private readonly options: ReadinessOptions) {}
  get draining(): boolean {
    /* ... */
  }
  hold(reason: string): void {
    /* ... */
  }
  release(): void {
    /* ... */
  }
  async onDrain(): Promise<void> {
    /* set draining, then await drainDelayMs */
  }
}

// packages/http/src/health/registry.ts - the wire format is declared here and
// imported by anything that renders it. One list, against terminus' four fields
// holding the same data partitioned three ways:
//   {"status":"up","draining":false,"uptimeMs":41233,
//    "checks":[{"name":"database","state":"up","critical":true,"ms":1}]}
export interface HealthCheckReport {
  readonly name: string;
  readonly state: ProbeState;
  readonly critical: boolean;
  readonly ms: number;
  readonly detail?: string;
}
export interface HealthReport {
  readonly status: ProbeState;
  readonly draining: boolean;
  readonly uptimeMs: number;
  readonly checks: readonly HealthCheckReport[];
}
export class HealthRegistry {
  constructor(options: HealthOptions, readiness: Readiness) {}
  /** Concurrent, each bounded by `timeoutMs`. Never throws. */
  report(indicators: readonly HealthIndicator[]): Promise<HealthReport>;
  liveness(): Promise<HealthReport>;
  readiness(): Promise<HealthReport>;
}
```

`status` comes from the **critical** checks only. A timeout is `unknown` and a throw
is `down`, the dashboard's existing rule (`packages/dashboard/src/api/runtime.ts:7`):
a probe that did not answer has told you nothing. `unknown` on a critical check fails
readiness and on a non-critical one it does not, so a disk at 91% reports without
pulling the pod out of rotation.

```ts
// packages/http/src/health/controller.ts - /ready mirrors live() against
// readiness(). Class and method decorators only; there are no parameter decorators.
@Controller('health')
@ApiHidden()
export class HealthController {
  constructor(private readonly health: HealthRegistry) {}
  @Public()
  @Get('/live', {})
  async live(): Promise<Response> {
    const report = await this.health.liveness();
    return Response.json(report, {
      status: report.status === 'up' ? 200 : 503,
    });
  }
}

// packages/http/src/health/module.ts
export class HealthOptions {
  readonly liveness: readonly HealthIndicator[];
  readonly readiness: readonly HealthIndicator[];
  readonly timeoutMs: number;
  readonly drainDelayMs: number;
  readonly routes: boolean;
  constructor(init: HealthOptionsInit = {}) {
    /* defaults 2000, 0, true */
  }
}
@Module({})
export class HealthModule {
  static forRoot(init?: HealthOptionsInit): DynamicModule;
  /** Same shape as StaticModule.forRootAsync. */
  static forRootAsync<const D extends Deps>(
    config: FactoryProvider<HealthOptionsInit, D>,
  ): DynamicModule;
}

// Wired the way DashboardModule.forRootAsync is, which is how an option value comes
// out of the container:
HealthModule.forRootAsync({
  useFactory: (db: DbConnection, redis: RedisConnection) => ({
    readiness: [new DatabaseIndicator(db), new RedisIndicator(redis)],
    liveness: [
      new MemoryIndicator(new MemoryOptions({ maxRssBytes: 512 * 2 ** 20 })),
    ],
    drainDelayMs: 15_000,
  }),
  inject: [DbConnection, RedisConnection],
});

// packages/core/src/di/lifecycle.ts - the addition
export interface OnDrain {
  /** Stop taking new work. Runs before the server stops accepting. */
  onDrain(): void | Promise<void>;
}
export const hasOnDrain = (value: unknown): value is OnDrain =>
  hasMethod(value, 'onDrain');
```

`App.drain()` runs every instance's `onDrain` under one `Promise.all`, not in
sequence: a drain is "stop taking new work" at every source at once, and serialising
would sum `Readiness`'s 15 s window onto the queue worker's close.
`HttpApplication.shutdown()` calls `await this.#app.drain()` before
`this.#server.stop()`, and `Application.shutdown()` calls it too, so a process with
no server gets it. `ShutdownHooks.install(drain, ...)` already names its first
parameter `drain` for the whole teardown; rename that one `teardown` in the same
change, or the codebase carries two meanings of the word.

## Where it lives

| Path                                                                    | Purpose                                                                                       |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/http/src/health/contracts.ts`                                 | `ProbeState`, `ProbeResult`, `HealthIndicator`, `PingProbe`, `QueryProbe`                     |
| `packages/http/src/health/indicators.ts`                                | the four indicators and their options classes                                                 |
| `packages/http/src/health/{readiness,registry}.ts`                      | `Readiness`/`ReadinessOptions`; `HealthRegistry`, the report types, the per-indicator timeout |
| `packages/http/src/health/controller.ts`                                | `HealthController` - two `@Public() @ApiHidden()` routes                                      |
| `packages/http/src/health/module.ts`, `index.ts`                        | `HealthModule`, `HealthOptions`, and the new exports on the barrel                            |
| `packages/http/src/health/*.test.ts`                                    | four files: registry, drain order, indicators, routes                                         |
| `packages/http/src/server/application.ts`                               | `await this.#app.drain()` ahead of `server.stop()`                                            |
| `packages/core/src/di/lifecycle.ts`                                     | `OnDrain`, `hasOnDrain`                                                                       |
| `packages/core/src/di/app.ts`                                           | `App.drain()`, called by `Application.shutdown()`                                             |
| `packages/core/src/di/shutdown-hooks.ts`                                | `drain` parameter renamed `teardown`                                                          |
| `packages/infra/src/db/connection.ts` plus `{sqlite,sql}/connection.ts` | `abstract ping(): Promise<void>` and its two dialect implementations                          |
| `packages/dashboard/src/{contracts,api/runtime}.ts`                     | four declarations and `redisProbe` deleted, re-exported from / replaced by `@dunx/http`'s     |

**Exports map: no change.** `@dunx/http` keeps `.` and `./client`; the surface is
added to `packages/http/src/index.ts`, where `StaticModule` and `StaticFiles` already
are, so `scripts/build-package.ts` derives the same entrypoints.

**Manifest fields: no change.** No new dependency in any of the four packages. The one
place that would have needed one, a db ping needing drizzle's `sql` tag, is why
`ping()` goes on `DbConnection` in `@dunx/infra/db`, which already peer-depends on
`drizzle-orm` and knows its own dialect.

## What it refuses

- **No third endpoint for startup.** `HttpFactory.create` resolves every provider and
  runs every `onInit` before `listen()` binds, so the port does not open until boot
  finished and a k8s `startupProbe` on `/health/live` gets connection refused until
  then. A `/health/startup` route has nothing to add.
- **No `?check=` query form.** Two paths are what a manifest reads and what a
  log-ignore prefix matches. **And liveness never touches a dependency**: a DB
  indicator there turns a database blip into every pod restarting.
- **No queue indicator.** A bullmq `Queue` reaches the broker through the same Redis,
  so `RedisIndicator` is that check; bull-board answers what is _in_ the queues and
  `@dunx/dashboard` already mounts it.
- **No HTTP-dependency indicator.** A readiness probe that fails on a third party's
  outage removes a pod that could still serve the traffic not touching it; an app
  wanting one writes eight lines against `HealthIndicator` and `@dunx/http/client`.
- **No OpenAPI operation.** `@ApiHidden()` is unconditional; a response schema would
  need zod, and zod is a peer of `@dunx/openapi`, never of `@dunx/http`.
- **No log-ignore default.** The module cannot reach `HttpOptions`: options are read
  before the container exists, which is W1 in
  `internal/notes/roadmap/class-modules-and-opt-in-config.md`. The app writes
  `requestLogging: { ignorePrefix: ['/health'] }`; defaulting it inside
  `RequestLoggingMiddleware` would silently stop logging an existing app's own
  `/health*` routes.
- **No status other than 200 and 503**, and **no configurable mount path**. A
  `Response` returned from a handler passes through untouched (`routes.ts:59`), so
  nothing is thrown and the error mapper is never involved. `health/live` and
  `health/ready` are prefixed by `setGlobalPrefix` like any controller route;
  `routes: false` plus an app's own controller injecting `HealthRegistry` is the
  escape hatch, at eight lines.

## Risks and open spikes

1. **`process.constrainedMemory()` in a cgroup is unverified.** It returned exactly
   `os.totalmem()` here and this host has no `/sys/fs/cgroup/memory.max`. Until it is
   checked inside a memory-limited container, `MemoryOptions` takes absolute bytes
   only; a `maxRssFraction` is a spike, not a field.
2. **`drainDelayMs` defaults to 0**, so the Kubernetes case is opt-in: a nonzero
   default would add that many milliseconds to every `app.shutdown()` in every
   downstream test suite. The guide states the arithmetic,
   `drainDelayMs >= readiness failureThreshold * periodSeconds` with
   `terminationGracePeriodSeconds` above that plus the drain.
3. **`OnDrain` needs a second consumer to have earned itself, and it has one.**
   `packages/infra/src/queue/worker.ts:369` says "Stop the consumer before shutting
   the app down. Nothing here can enforce it, because `App` has no hook to register
   against." `WorkerFactory` implementing `onDrain` closes that, and belongs in the
   same change or the hook ships with one user.
4. **Gateways change what the window is for.** `server.stop()` never resolves while a
   WebSocket is open (`docs/bun-apis.md:232`), so `shutdown()` already forces the stop
   when a gateway exists, making `drainDelayMs` the only thing letting a client
   reconnect elsewhere before its socket takes a 1006.
5. **`@Unlogged()` as a meta key instead of a path list.** `RouteContext.get` is a
   Map lookup a route already carries: `1.60 ns/call` against `2.66 ns/call` for the
   existing `ignore` Set check (`bun probes/metaget.ts`), both unmeasurable against
   5.38 us. It would survive `setGlobalPrefix` and could not go stale, where a path
   list can. A second mechanism for one behaviour is a Rule 2 question, so: a spike,
   not part of this build.
6. **A global guard registered through `HttpOptions.middleware` runs on the health
   routes.** `@Public()` covers a guard written to honour it and `SessionGuard` is.
   A rate limiter is the case that bites, and the reference app has exactly that bug
   asserted in its own e2e suite. The guide names it; dunx cannot fix somebody
   else's middleware.
7. **`DbConnection.ping()` is a breaking change to an abstract class.** A consumer
   subclassing it outside the repo fails to compile. It is documented as the
   injectable contract rather than an extension point and versioning is lockstep
   pre-core-1.0, so this rides the next minor, stated in `CHANGELOG.md` prose.

## Cost

**Files.** 6 new source plus 4 test files in `packages/http/src/health/`, and edits
to the 8 existing files in the table above. **~520 LOC source, ~420 test**; nothing
near the 500-line cap, `indicators.ts` largest at ~170. **No new dependency**, in
any package.

**Docs.** Rewrite `## Health checks` in `docs/guide/19-deployment.md`, which currently
tells the reader to hand-roll a controller, and extend `## Shutting down cleanly` with
the drain window. Add `OnDrain` to `docs/guide/07-lifecycle.md`. Record the memory and
disk measurements in `docs/bun-apis.md`, and the `heapStats()` cost plus the library
survey in a new `docs/architecture/health.md`, kept out of `PUBLISHED_REFERENCE`.
Update `packages/http/README.md`.

**Examples.** `examples/full/src/health/` becomes `HealthModule.forRootAsync` and
loses its 65-line controller; its wiring gains `ignorePrefix: ['/health']`.
`tools/create-app/templates/features/health/` likewise, replacing 79 lines, and the
`health` feature's dependency list (`tools/create-app/src/features.ts:258`) can then
drop `files`, since the controller that needed `Storage` is gone, changing
`tools/create-app/src/features.test.ts:166`.

**CI.** No new workspace, so no new job, no coverage badge and no `PUBLISHABLE_DIRS`
change; `bun run gen:cov` picks the files up under `packages/http`. Four packages take
a lockstep version bump instead of one.

**Runtime cost, measured.** Liveness handler `0.95 us`; readiness with memory and disk
`10.98 us` (`bun probes/handler.ts`). One probe's request log entry is **313 bytes**,
captured from a real `HttpFactory` app (`bun probes/app/health-log.ts`):

```
{"level":"info","timestamp":"...","pid":1110205,"message":"GET /health/live 200","requestId":"...","method":"GET","event":"/health/live","flow":"http","context":"HealthController.live","request":{"userAgent":"kube-probe/1.34"},"statusCode":200,"elapsedMs":1}
period 1s -> 27.04 MB/pod/day, 86,400 lines/pod/day
period 2s -> 13.52 MB/pod/day, 43,200 lines/pod/day
period 5s ->  5.41 MB/pod/day, 17,280 lines/pod/day
```

Double it for liveness plus readiness. The CPU is not the cost: request logging is
`+5.38 us/request` (`docs/architecture/cost-of-logging.md`) against a `0.95 us`
handler, so logging is 5.6x the work it describes and 27 MB/pod/day of it says `200`.
The 503 half is worse: `request-logging.ts:371` logs a 5xx at `error`, and
`ConsoleLogger` never batches `error` and flushes everything queued behind it, so a
15 s drain window at a 2 s probe period is eight unbatched writes and eight entries
in whatever counts the error rate. `ignorePrefix: ['/health']` costs one line and
returns `next()` before any of it runs.
