# bullmq over Redis

`@dunx/infra/queue` runs bullmq jobs on dunx services.
It decides where a handler lives, how it is found and injected, and when it
stops. Retries, backoff, rate limits and scheduling come from bullmq itself.

```bash
bun add bullmq ioredis
```

Both are **optional peer dependencies**, so an app using only `@dunx/infra/files`
installs neither. `ioredis` is there for bullmq's sake rather than dunx's: see
[the ioredis boundary](#the-ioredis-boundary) below.

## Choosing a backend

dunx has two queue backends: bullmq, on this page, and
[RabbitMQ over AMQP](./20-message-brokers.md). Pick by what you need:

| Ask                                                        | Reach for                                     |
| ---------------------------------------------------------- | --------------------------------------------- |
| Retry with backoff, a rate limit, a cron, a job dashboard  | `@dunx/infra/queue`, this page                |
| A payload another deployable consumes, broker-side routing | [`@dunx/infra/amqp`](./20-message-brokers.md) |

A unit of work this process created for itself to do later is a job. A message
whose consumers this process does not know about is a message. An app can hold
both, and `examples/full` does.

There is no `driver: 'rabbitmq'` switch on `QueueModule`. bullmq's `attempts`,
`backoff` and `delay` have no AMQP equivalent, so a shared option object would
accept settings one backend silently ignores. The measurements are in
[architecture/message-brokers.md](../architecture/message-brokers.md).

## A handler is a method with a decorator

That is the whole registration. No class decorator, no registry, no queue token.

```ts
import { Logger } from '@dunx/core';
import { JobHandler } from '@dunx/infra/queue';
import type { Job } from 'bullmq';

export class Emails {
  constructor(
    private readonly mailer: Mailer,
    private readonly logger: Logger,
  ) {}

  @JobHandler({ queue: 'emails', name: 'welcome' })
  async welcome(job: Job<{ to: string }>): Promise<{ sent: string }> {
    await this.mailer.send(job.data.to, 'Welcome');
    this.logger.info(`welcomed ${job.data.to}`);
    return { sent: job.data.to };
  }
}
```

`Emails` is declared in `@Module({ providers })` like any other injectable, and it
injects by constructor like any other class. The same service the HTTP routes use
does the work here, with no second wiring.

### How a handler is found

The same **marker-plus-prototype-scan** that routes and websocket gateways use.
`@JobHandler` sets a symbol property on the method function it receives and
returns it; nothing is recorded anywhere else. At boot, `WorkerFactory` walks the
prototype chains of the classes the modules already declare, and a marked method
is a job.

What follows from that:

- **No second registration.** There is no `registerQueue`, no `@Processor` class
  decorator, and no queue token to inject.
- **A handler may be inherited.** An abstract base's marked method is found on
  every subclass, and overriding it _without_ re-decorating still works, because
  the marker is on the base's function and dispatch is bound off the instance, so
  it lands on the override.
- **Two handlers for one `(queue, name)` pair is a boot error** naming both. It
  would otherwise silently split the traffic between them.
- **A factory- or value-provided instance is not scanned.** There is no class to
  read a prototype chain from until it has been built. Put handlers on a class
  provider.

A job whose name no handler claims fails, and the error lists the names that
worker does handle. This usually means the worker was deployed before the code
with the handler. bullmq retries the job under its own `attempts`.

## Setup

One module, imported by **every** process that touches a queue:

```ts
import { Module } from '@dunx/core';
import { QueueModule } from '@dunx/infra/queue';

@Module({
  imports: [QueueModule.forRoot({ url: 'valkey://localhost:6379' })],
  providers: [Emails, Mailer],
})
export class JobsModule {}
```

`forRootAsync` is the same thing with the options behind a factory that may await
and may inject:

```ts
QueueModule.forRootAsync({
  useFactory: (config: AppConfigService) => {
    const { url } = config.get('redis');
    return { ...(url === undefined ? {} : { url }), prefix: 'dunx-full' };
  },
  inject: [AppConfigService] as const,
});
```

With no `url` it follows the same chain `@dunx/infra/redis` does: `$VALKEY_URL`,
then `$REDIS_URL`, then `valkey://localhost:6379`. The URL is validated when the
module is configured rather than on first connect.

### Options

| Option              | Default                                                     | Notes                                                     |
| ------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| `url`               | `$VALKEY_URL`, `$REDIS_URL`, then `valkey://localhost:6379` | Validated at configuration time                           |
| `prefix`            | `'bull'`                                                    | bullmq's key prefix                                       |
| `worker`            | `{}`                                                        | Forwarded verbatim to every `Worker`                      |
| `defaultJobOptions` | none                                                        | Forwarded verbatim as every `Queue`'s `defaultJobOptions` |
| `connection`        | `{ connectionTimeout: 5000, maxRetries: 0 }`                | Forwarded to every `Bun.RedisClient`                      |
| `jobTimeoutMs`      | none                                                        | Not a bullmq feature. See below                           |
| `consume`           | `false`                                                     | `true` or `'if-any'` opens workers in this process        |
| `processor`         | none                                                        | Absolute path bullmq forks into for a `background` queue  |
| `isolation`         | `'process'`                                                 | `'thread'` runs a `background` queue on a worker thread   |

`worker` and `defaultJobOptions` are passed to bullmq unchanged. `concurrency`,
`limiter`, `lockDuration`, `stalledInterval`, `attempts`, `backoff`,
`removeOnComplete` and the rest are bullmq's options; see bullmq's docs for them.

### Counting jobs

`forRoot` and `forRootAsync` both take a **second argument**, `QueueModuleSettings`.
It has one field:

```ts
QueueModule.forRoot({ url }, { metrics: true });
```

That binds and exports `QueueMetrics`, which counts enqueues and handler runs and
times both. Inject it and call `snapshot()` for a `QueueStatsReport`: per
`(queue, name)` totals for `published`, `handled`, `failed`, `timedOut` and
`publishErrors`, with a `HistogramSnapshot` for each duration. `reset()` clears
them.

Publishes are always counted in the process that publishes. Handler runs are
counted here only when this process consumes with `consume: true`. A
`background: true` job and a `WorkerFactory` process each run in their own
container, with their own `QueueMetrics`. [Metrics](./24-metrics.md) covers
reading the report and the limit on the number of series.

### Why `connection` is bounded by default

Both halves of `{ connectionTimeout: 5000, maxRetries: 0 }` were measured rather
than guessed.

With Bun's own defaults, a client that cannot reach Redis retries **without
bound**, so `publish()` never settles and a route waiting on it hangs instead of
answering. With the bounded default it rejects in single-digit milliseconds and a
controller can map that to a 503.

And with **any** `maxRetries > 0`, a client that never connected keeps a retry
timer alive past `close()` and the process never exits. Verified at
`maxRetries: 3`, where a full-example boot with no Redis survived `SIGTERM` for
12 s. So `0` is the only default that both fails fast and lets the process die.

The cost: **with `0`, a worker does not reconnect after a short Redis outage.**
Raise it if reconnecting matters more to you than exiting cleanly when Redis is
missing at startup. You cannot have both until Bun clears the timer on `close()`.

`maxRetries: 0` does not fix two other shutdown hangs; see
[Read this before you deploy it](#read-this-before-you-deploy-it).

### The connection bullmq builds for itself is bounded too

bullmq does not keep the client it is handed. A `Worker`'s blocking connection is
`connection.duplicate()`, and every reconnect rebuilds one, both with
`new (this.raw.constructor)(this.raw.url)`.

With a plain `Bun.RedisClient`, that rebuilt client would lose two things:

- **Its options.** `maxRetries: 0` would apply only to the first socket.
- **Its url.** `Bun.RedisClient` has **no `url` property** on Bun 1.3.14, so the
  new client would use Bun's default (`$VALKEY_URL`, `$REDIS_URL`,
  `valkey://localhost:6379`). A worker set up for a remote Redis would poll
  localhost and never see a job.

`QueueConnection` hands bullmq a `Bun.RedisClient` **subclass** that keeps the
url and the options, so every rebuilt client matches the first. There is nothing
to configure.

## Read this before you deploy it

One known defect.

**A process that tried a queue operation while Redis was unreachable does not
exit on `SIGTERM`.** The cause is two upstream bugs, one in Bun and one in
bullmq, and app code cannot work around either. Each layer tested on its own,
with `connectionTimeout: 2000, maxRetries: 0`:

| server                      | `Bun.RedisClient` | bullmq's adapter | a bullmq `Queue` |
| --------------------------- | ----------------- | ---------------- | ---------------- |
| healthy                     | exits 0           | exits 0          | exits 0          |
| refused (nothing listening) | exits 0           | **never exits**  | **never exits**  |
| black-holed (SYN dropped)   | **never exits**   | **never exits**  | **never exits**  |

The black-holed row is a Bun bug. A connect that never completes keeps the
process alive after `close()`, whatever the client options.

The refused row is a bullmq bug. Its adapter schedules reconnects with
`setTimeout`. Once the connection has dropped, `disconnect()` and `quit()` return
early, so that pending reconnect is never cancelled.

An app that imports `QueueModule` without publishing is unaffected, and so is a
healthy deployment. What hangs is a process that served a queue route while Redis
was unreachable.

Requests are still **served correctly**, with a 503 in single-digit
milliseconds. Only shutdown is affected, and your process supervisor will
`SIGKILL` it.

Earlier versions of this guide said to **pin ioredis 5**. That was wrong: any
ioredis from 5.0.0 up works, including 6. The measurement is in
[architecture/queues.md](../architecture/queues.md), "Not pinning ioredis 5".

## Publishing and consuming are separate decisions

`QueueModule.forRoot()` exports four tokens: `QueueOptions`, `QueueConnection`,
`JobPublisher` and `JobEvents`, plus `QueueMetrics` when `metrics: true`. Those
are the **publish** side, which is all a web process needs. It also binds a
provider it does not export, `QueueRunner` - the piece that opens workers when you
ask it to.

**By default it consumes nothing.** `consume` is `false`, so a web process that
publishes never starts a worker by accident. There are four ways to consume, and
they agree on exactly one thing: the module.

| How                                          | Where the workers live                           |
| -------------------------------------------- | ------------------------------------------------ |
| `QueueModule.forRoot({ consume: true })`     | the container that imported the module           |
| `QueueModule.forRoot({ consume: 'if-any' })` | the same, and stands down when no handler exists |
| `WorkerFactory.create(root)`                 | a process of its own, with its own container     |
| `WorkerFactory.attach(app, root)`            | a container somebody else already built          |

`consume: true` is the one to reach for first. `QueueRunner` implements `OnInit` and
`OnShutdown`, so the workers start with the container and stop with it, before the
connections the handlers use are closed. That ordering is why it lives in a module
rather than in an entrypoint: nothing an app writes by hand can guarantee teardown
runs in the right order.

```ts
@Module({
  imports: [QueueModule.forRoot({ url, consume: true, processor })],
  providers: [ThumbnailJobs],
})
export class JobsModule {}
```

If Redis is down, boot still succeeds. The runner logs an `error` saying the
process is serving but not consuming.

A processor file can import a `consume: true` module safely. The forked
`background` child has `DUNX_JOB_WORKER` set, and the runner opens no workers
when it is set, so the child does not fork itself again.

`consume: true` with no `@JobHandler` anywhere in the graph is a boot error: a
process that consumes nothing is one nobody notices. `consume: 'if-any'` stands
down with a warning instead, for an incremental migration where the queue wiring
lands several commits before the first handler. Two handlers claiming one
`(queue, name)` stays a boot error under both.

### Isolation is per handler, and per queue in effect

`@JobHandler({ queue, name, background })` marks one handler. With
`background: true`, bullmq runs the job in a forked process from the file named by
`QueueModule.forRoot({ processor })`. Use it to keep a CPU-heavy handler off the
event loop that serves requests.

Two things about it are easy to get wrong.

- **`processor` must be an absolute path.** bullmq resolves it in the child. A
  `background` queue with no `processor` configured is a boot error at `start()`.
- **`background` is declared per handler but takes effect per queue.** bullmq opens
  one `Worker` per queue and takes either a file path or a function, so one marked
  handler sandboxes every handler on that queue.

`isolation` is **not** a `@JobHandler` option. It is
`QueueModule.forRoot({ isolation })`, and it defaults to `'process'`. Keep it there:

- A fork is a new Bun process. It reads `bunfig.toml`, so the transform preload
  runs and constructor injection works in the child.
- `'thread'` starts from bullmq's prebuilt worker file, where the preload does not
  apply to your `.ts` files. The first provider with a constructor parameter then
  fails at boot.

`'thread'` is usable only against a tree whose dependencies were recorded at build
time.

The file itself default-exports the processor's `handle`:

```ts
// src/jobs.processor.ts - the file bullmq forks
import { JobProcessor } from '@dunx/infra/queue';
import { JobsProcessorModule } from './jobs.processor.module.js';

export default new JobProcessor(JobsProcessorModule).handle;
```

Export `.handle` as shown. bullmq calls it as a plain function, and it still
works because it is an arrow function. The first job builds the child's
container, and later jobs reuse it.

`JobProcessor` takes a second argument, `JobProcessorOptions`:

| Option       | Default | Does                                                                     |
| ------------ | ------- | ------------------------------------------------------------------------ |
| `queues`     | none    | Consume only these, matching the parent's filter                         |
| `trace`      | `true`  | Write start, success and failure to `job.log()`, which bull-board shows  |
| `onShutdown` | none    | `(app) => ...`, run before the child's container tears down on `SIGTERM` |

`trace` writes to the job's own log in Redis rather than to stdout, so the lines
survive the container being recycled and stay attached to the job an operator is
looking at. Each costs one Redis write, capped by bullmq's `keepLogs`.

OpenTelemetry spans are separate from `trace`. A forked handler gets one when the
processor file registers an SDK; see [Tracing](./31-tracing.md#queues).

### Publishing

```ts
import { JobPublisher } from '@dunx/infra/queue';

export class Signups {
  constructor(private readonly jobs: JobPublisher) {}

  async register(email: string): Promise<void> {
    await this.jobs.publish('emails', 'welcome', { to: email });
  }
}
```

`publish(queue, name, data, options?)` returns bullmq's own `Job`, and
`publisher.queue(name)` returns bullmq's own `Queue`, with `addBulk`,
`upsertJobScheduler`, `getJobCounts`, `drain` and everything else already on it.
There is no wrapper to outgrow.

A queue is opened on **first use** rather than declared up front. A queue is a key prefix,
not a resource to reserve, so there is nothing a registration step could validate
and nothing gained by holding a socket for a queue nobody publishes to.
`publisher.opened` reports the names opened so far, and `onShutdown` closes each
of them.

### The worker process

```ts
// src/worker.ts
import { ConfigModule, Logger, Module } from '@dunx/core';
import { LoggerModule } from '@dunx/infra/logger';
import { WorkerFactory } from '@dunx/infra/queue';
import { AppConfigService, validate } from './config.js';
import { JobsModule } from './jobs/jobs.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ validate, as: AppConfigService }),
    LoggerModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        name: `${config.get('appName')}-worker`,
        level: config.get('log').level,
      }),
      inject: [AppConfigService] as const,
    }),
    JobsModule,
  ],
})
class WorkerModule {}

const worker = await WorkerFactory.create(WorkerModule);
await worker.start();
worker.enableShutdownHooks();
await worker.closed;
```

```json
{ "scripts": { "worker": "bun run src/worker.ts" } }
```

Pass the app's root module or a smaller one without the controllers. Either way
it builds a normal dunx container, and handlers get constructor injection like
controllers do.

**`create` discovers and validates; `start` is what opens connections.** So a
wiring mistake fails before anything consumes, and `worker.jobs` can be inspected
in a test with no server running:

| Mistake                              | Error at `create`                                                       |
| ------------------------------------ | ----------------------------------------------------------------------- |
| No `QueueModule` in the graph        | `ERR_QUEUE_INVALID_STATE`                                               |
| No marked method anywhere            | `ERR_QUEUE_NO_HANDLERS`                                                 |
| A name in `queues` no handler claims | `ERR_QUEUE_NO_HANDLERS`, naming both what is missing and what was found |
| Two handlers on one `(queue, name)`  | `ERR_QUEUE_DUPLICATE_HANDLER`                                           |

The `QueueModule` check looks at the imported modules. Without it, a missing
`QueueModule` would not be noticed: `QueueOptions` would be created with its
defaults, and the worker would quietly connect to `localhost`.

`WorkerApp` carries `jobs` (every handler after the filter), `queues` (what this
process will consume), `start()`, `shutdown()`, `enableShutdownHooks()`, `closed`
and `get(token)`.

### One queue, one process

```ts
const worker = await WorkerFactory.create(AppModule, { queues: ['emails'] });
```

Use this to give one queue its own process and its own concurrency. A name in
`queues` that no handler claims fails at boot, so a misspelled queue name is
caught.

## Serving and consuming in one process

`WorkerFactory.attach(app, root, options?)` consumes inside a container that
**already exists**, so a single process can serve HTTP and work the queues:

```ts
import { HttpFactory } from '@dunx/http';
import { WorkerFactory } from '@dunx/infra/queue';
import { AppModule } from './app.module.js';

const app = await HttpFactory.create(AppModule);
const consumer = await WorkerFactory.attach(app, AppModule);

await app.listen(3000);
await consumer.start();
```

Pass the same root module the app was built from. The handlers are found in it
and resolved from the running container.

It returns a **`QueueConsumer`** with `jobs`, `queues`, `start()` and `stop()`.
This is the same class `WorkerFactory.create` uses internally, without an `App`
of its own, so both behave the same.

`attach` validates with exactly the same rules as `create`. No handlers, or a
named queue nothing consumes, are both boot errors. The difference is what happens
on failure: `attach` leaves the caller's container running, because it does not
own it.

### Stop the consumer before you shut the app down

```ts
await consumer.stop();
await app.shutdown();
```

`consumer.stop()` closes the workers and **nothing else**. Calling it twice is
safe. It stops fetching new jobs and waits for running jobs to finish.

**Nothing can enforce that ordering.** Core's `App` exposes no hook to register
against, so `attach` cannot arrange to run first, and a worker still running when
providers tear down finds its database connection closed underneath it.

A worker **process** gets the ordering for free, because `WorkerApplication` owns
the container and its `shutdown()` runs `consumer.stop()` before
`app.shutdown()`. An attached consumer does not, so the caller has to sequence it.

Which to reach for:

- **`consume: true`** when one process is the whole deployment, which is most
  deployments. The container owns start and stop ordering, and a `background`
  handler still gets its own process per burst.
- **A separate worker process** when the two halves should scale, fail and deploy
  independently.
- **`attach`** when a container already exists and you are adding consumption to it
  after the fact. It is the only one of the three where you have to sequence
  teardown yourself.

## `jobTimeoutMs`

The one behaviour here that bullmq does not already own.

bullmq has `lockDuration` and stall detection, which answer _did the worker die_,
not _is this handler stuck_. A handler hung on an external call holds its lock,
renews it, and never finishes. `jobTimeoutMs` rejects it with
`ERR_QUEUE_TIMED_OUT` so the job fails and retries under its own `attempts`. Off
by default.

## Shutdown

`worker.shutdown()` closes every bullmq `Worker` **before** the container tears
down, so an in-flight job finishes while the database connection it is using is
still open. `close()` without `force` stops fetching and waits for what is
already running.

The container's own reverse-construction-order teardown then closes the
publisher's queues, and last of all the sockets. `QueueConnection` is constructed
first, because everything else needs it, so it goes last.

`enableShutdownHooks()` wires `SIGTERM` and `SIGINT` to that sequence.

## The ioredis boundary

dunx's own code uses `Bun.RedisClient`, not `ioredis`. bullmq still needs
`ioredis` installed, for the reasons below.

**Every byte of queue traffic goes through `Bun.RedisClient`.** bullmq accepts
either a connection description it builds a client from, or an already-built
client implementing its `IRedisClient` interface, and bullmq 6 ships
`createBunRedisClient`, an adapter over Bun's client. `QueueConnection` uses it.
dunx neither imports nor constructs ioredis, and `dist/` contains no reference to
it.

Tested with that adapter on bullmq 6.0.5, Bun 1.3.14 and Redis 8.4.0 (the run
takes 0.5 s):

- concurrency 5 is respected across 20 jobs
- `attempts: 2` with fixed backoff retries a throwing handler exactly once
- a delayed job reports state `delayed` and then runs
- `worker.close()` waits 244 ms for a 250 ms handler instead of dropping it

Three findings shaped the code:

- **bullmq cannot load without ioredis, in either of its builds.** It imports
  `ioredis` and `ioredis/built/utils` at the top of `utils/index` and
  `classes/redis-connection`, so `import { Queue } from 'bullmq'` throws
  `Cannot find module` without it. This is true even though bullmq 6 lists
  `ioredis` as an _optional_ peer and ships three other backends. It is the only
  reason `ioredis` is an optional peer of `@dunx/infra`.

  You need it only if you use `/queue`, the same as `bullmq`, so
  `bun add bullmq ioredis` installs both. Any version from 5.0.0 works, which is
  the range bullmq declares.

- **bullmq does not close a connection you give it.** `CLIENT LIST` showed four
  connections, and three were still open after `worker.close()` and
  `queue.close()`. bullmq closed only the copy it created.
  `QueueConnection.onShutdown` closes the rest.
- **Closing one afterwards emits `error` on an emitter with no listener**, because
  bullmq detaches its own handler on close and Node's `EventEmitter` throws for an
  unhandled `error`. Shutdown would fail on its last step. The adapter gets a no-op
  `error` listener at construction.
- **The adapter has to be disconnected before its socket is closed.** bullmq reads
  a socket that closed without being told to as a blip and schedules a reconnect,
  which would rebuild the connection being torn down. `QueueConnection.onShutdown`
  calls `disconnect()` on the adapter and then `close()` on the socket - both, in
  that order, because `disconnect()` skips the close for a client that never
  finished connecting.

Each bullmq object gets **its own client**. A `Worker` blocks on `BZPOPMIN`, and
bullmq copies any client it is given to get one it can block on, so sharing one
client would save nothing.

`@dunx/infra/redis` is untouched and unshared: a queue's sockets are its own. See
`packages/infra/README.md` for the Redis client itself.

### The subpath is the only way in

`@dunx/infra/queue` is **not exported from `@dunx/infra`** itself, and neither
are `/amqp`, `/db` and `/pagination`. Each one imports an optional peer at load
time. If `@dunx/infra` exported this one, every `import '@dunx/infra'` would need
bullmq and ioredis installed, even in an app with no queues.

## Testing with no Redis running

Discovery, dispatch, options and module wiring need no server at all. `create`
opens no socket, so a container can be built, inspected and torn down against an
address that is never dialled:

```ts
const worker = await WorkerFactory.create(WorkerModule);
expect(worker.jobs.map((job) => `${job.queue}/${job.name}`)).toEqual([
  'emails/welcome',
]);
await worker.shutdown();
```

dunx's own integration suite probes the server first and skips itself when nothing
answers, so `bun test` passes on a machine with no Redis.

## A dashboard

`@dunx/dashboard` mounts [bull-board](https://github.com/felixmosh/bull-board) at
`{path}/queues`, behind the same `authorize` callback as every other panel:

```ts
app.use(DashboardMiddleware);
```

dunx renders no queue UI of its own. `@dunx/queue-dashboard` existed for one
release and was deleted; bull-board 8.6.0 ships a `Bun.serve` adapter, which
removed the only reason to hand-roll one. `commands: false` maps onto
bull-board's `readOnlyMode`.

A read-only one is at
[demo.dunx.win/api/dashboard/queues](https://demo.dunx.win/api/dashboard/queues).

The board is built on the **first request for the queues page**, never at boot, so
an app that never opens it holds no broker socket and exits cleanly against an
absent Redis.

For your own panel, the queue data is four calls on bullmq's own `Queue`, which
`JobPublisher.queue(name)` hands you:

```ts
const queue = publisher.queue('emails');

await queue.getJobCounts(); // waiting, active, completed, failed, delayed
await queue.getJob(id); // one job: state, result, failedReason, attempts
await (await queue.getJob(id))?.retry();
await queue.drain(); // discard everything waiting
```

Serving that as an admin-only JSON controller takes about sixty lines.

`getWorkers()` **works**, and was long believed not to. It reported `[]` on Bun
even while workers drained jobs.

The cause was that `QueueConnection` dropped the `{ connectionName }` argument
bullmq passes to `duplicate`, so the connection was never named. That is fixed.
`CLIENT SETNAME` now runs and the worker is listed.

## Waiting for a job to finish

The process that published a job does not run it, so `job.returnvalue` on the
handle `publish` returned stays empty: it is filled when the job is loaded, and
that load happened in the worker.

`JobEvents` hands over bullmq's `QueueEvents` for a queue, which is what
`waitUntilFinished` waits on:

```ts
import { JobEvents, JobPublisher } from '@dunx/infra/queue';

export class Thumbnails {
  constructor(
    private readonly jobs: JobPublisher,
    private readonly events: JobEvents,
  ) {}

  async render(width: number): Promise<Rendered> {
    const job = await this.jobs.publish('thumbnails', 'render', { width });
    // Resolves when the worker completes it, rejects on a failure or the ttl.
    return await job.waitUntilFinished(this.events.events('thumbnails'), 8_000);
  }
}
```

bullmq writes each event to a Redis stream and `QueueEvents` blocks on `XREAD`,
so this costs no polling. The
alternative is `queue.getJob(id)` on a timer, which is what a status endpoint
does instead: an HTTP request cannot hold a socket open for eight seconds, so
`GET /jobs/:id` reports the state it finds and the caller asks again.

Two things to know about the stream:

- **A queue's stream opens on the first `events()` call**, not at boot. bullmq
  starts a blocking read in the constructor, so a process that publishes and
  never waits holds no extra connection.
- **It is closed for you** at shutdown, before the sockets it borrowed. A stream
  that will not close within two seconds is logged and abandoned rather than
  waited on, because `close()` against an unreachable broker never settles.

## Errors

Everything this subpath throws is a `QueueError`, an `AppError` carrying a `code`.
Both the class and the `QueueErrorCode` table are exported, so a catch can branch
on the code without matching a message:

```ts
import { HttpError } from '@dunx/http';
import { QueueError, QueueErrorCode } from '@dunx/infra/queue';

try {
  await this.jobs.publish('emails', 'welcome', { to });
} catch (error) {
  if (
    error instanceof QueueError &&
    error.code === QueueErrorCode.INVALID_STATE
  ) {
    throw new HttpError(503, 'the queue is unavailable');
  }
  throw error;
}
```

| Code                          | Raised when                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- |
| `ERR_QUEUE_DUPLICATE_HANDLER` | Two handlers claim one `(queue, name)`. Boot                                |
| `ERR_QUEUE_NO_HANDLERS`       | A worker found nothing to consume, or a named queue nothing claims. Boot    |
| `ERR_QUEUE_UNKNOWN_JOB`       | A job arrived no handler claims. bullmq retries it under its own `attempts` |
| `ERR_QUEUE_TIMED_OUT`         | A handler outran `jobTimeoutMs`                                             |
| `ERR_QUEUE_INVALID_URL`       | The url is not a Redis or Valkey url. Configuration time                    |
| `ERR_QUEUE_INVALID_STATE`     | Published after teardown, no `QueueModule` in the graph, or `start()` twice |

## Everything `@dunx/infra/queue` exports

An app usually injects only the tokens above. The rest are for tests and custom
dashboards.

| Export                                                       | Kind           | For                                                                 |
| ------------------------------------------------------------ | -------------- | ------------------------------------------------------------------- |
| `QueueModule`, `QueueModuleSettings`                         | module         | `forRoot`, `forRootAsync`, and the `metrics` flag                   |
| `QueueOptions`, `QueueOptionsInit`                           | token, type    | Resolved settings; `redactedUrl` for a log line                     |
| `WorkerPassthrough`                                          | type           | What `worker` accepts: bullmq's own, less `connection` and `prefix` |
| `QueueConnection`                                            | token          | The `Bun.RedisClient` subclass bullmq is handed                     |
| `JobPublisher`                                               | token          | `publish()`, `queue(name)`, `opened`                                |
| `JobEvents`                                                  | token          | `events(name)` for `waitUntilFinished`, `opened`                    |
| `JobHandler`                                                 | decorator      | Marks a method                                                      |
| `JobMeta`                                                    | type           | What the decorator records: `queue`, `name`, `background`           |
| `QueueRunner`                                                | provider       | Opens workers for `consume`. Bound, never exported                  |
| `WorkerFactory`, `WorkerApp`, `WorkerAppOptions`             | factory, types | A worker process, or `attach` to one already built                  |
| `QueueConsumer`                                              | class          | The consuming half `create` and `attach` both return                |
| `JobProcessor`, `JobProcessorOptions`                        | class, type    | The child half of a `background` handler                            |
| `JobDispatcher`                                              | class          | Runs one job: the timeout, the logging, the metrics                 |
| `discoverJobs`, `discoverJobsOn`, `selectJobs`               | functions      | The prototype scan, for a test that asserts on wiring               |
| `DiscoveredJob`, `JobHandlerFn`                              | types          | What discovery returns                                              |
| `describeJob`                                                | function       | `<id> <queue>[<name>]`, the identity every job log line carries     |
| `QueueMetrics`, `JobStats`, `QueueStatsReport`, `JobOutcome` | token, types   | Counters, under `metrics: true`                                     |
| `QueueError`, `QueueErrorCode`                               | class, codes   | The table above                                                     |

## Related

- [RabbitMQ over AMQP](./20-message-brokers.md), the other backend, for messages
  consumed by other services
- [Configuration](./12-configuration.md) for `forRootAsync` and `AppConfigService`
- [Logging](./13-logging.md), which the worker uses for job completion and failure
- [Metrics](./24-metrics.md) for reading `QueueMetrics`
- [Tracing](./31-tracing.md#queues) for spans around publish and handler, forked
  handlers included
- `examples/full`, whose `src/jobs/` is the worked example this page is drawn from.
  It sets `consume: true` and ships a `jobs.processor.ts`, so it spawns no worker
  process of its own
