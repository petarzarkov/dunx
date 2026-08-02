# Queues

**bullmq is the queue.** dunx adds no retry policy, no backoff, no rate limiter and
no scheduler: those are bullmq's, and a second implementation of them would be a
worse one.

What `@dunx/infra/queue` contributes is the four things bullmq has no opinion
about: where a handler lives, how it is found, how it is injected, and when it
stops.

```bash
bun add bullmq ioredis
```

Both are **optional peer dependencies**, so an app using only `@dunx/infra/files`
installs neither. `ioredis` is there for bullmq's sake, not dunx's: see
[the ioredis boundary](#the-ioredis-boundary) below.

## Read this before you deploy it

One known defect, recorded in `docs/ROADMAP.md`.

**A process that attempted a queue operation while Redis was down does not exit on
`SIGTERM`.** bullmq creates its connection on first use and holds a handle whose
retry timer outlives `close()`. `maxRetries: 0` does not clear it, because the
handle is bullmq's rather than Bun's, and nothing in userland can reach it.

The trigger is narrow, and it was measured rather than assumed:

| Redis       | Published? | `SIGTERM`       |
| ----------- | ---------- | --------------- |
| unreachable | no         | exits in ~1 s   |
| unreachable | yes        | **never exits** |
| reachable   | yes        | exits in ~2 s   |

So a healthy deployment is unaffected, and an app that imports `QueueModule`
without publishing is unaffected. What hangs is a process that served a queue
route while Redis was down. It **serves correctly throughout**, answering 503 in
single-digit milliseconds, so this is a shutdown defect, not an availability one.
The process will be `SIGKILL`ed by whatever supervises it.

`Bun.RedisClient` alone is clean in the same scenario: it rejects with
`Max reconnection attempts reached` and the process exits 0.

Earlier versions of this guide also told you to **pin ioredis 5**. That advice was
wrong and has been withdrawn: ioredis 6 did not remove `ioredis/built/utils`, both of
bullmq's builds import it, and Bun runs the CJS one. Any ioredis from 5.0.0 up works.
The measurement is in ARCHITECTURE.md, "Not pinning ioredis 5".

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

An arriving job whose name no handler claims fails with a message saying what that
worker _does_ serve. The shape of that bug is usually a worker deployed ahead of
the handler that serves it, and bullmq retries under the job's own `attempts`.

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
module is configured, not on first connect.

### Options

| Option              | Default                                                     | Notes                                                     |
| ------------------- | ----------------------------------------------------------- | --------------------------------------------------------- |
| `url`               | `$VALKEY_URL`, `$REDIS_URL`, then `valkey://localhost:6379` | Validated at configuration time                           |
| `prefix`            | `'bull'`                                                    | bullmq's key prefix                                       |
| `worker`            | `{}`                                                        | Forwarded verbatim to every `Worker`                      |
| `defaultJobOptions` | none                                                        | Forwarded verbatim as every `Queue`'s `defaultJobOptions` |
| `connection`        | `{ connectionTimeout: 5000, maxRetries: 0 }`                | Forwarded to every `Bun.RedisClient`                      |
| `jobTimeoutMs`      | none                                                        | Not a bullmq feature. See below                           |

`worker` and `defaultJobOptions` are **passthroughs on purpose**. `concurrency`,
`limiter`, `lockDuration`, `stalledInterval`, `attempts`, `backoff`,
`removeOnComplete` and the rest are bullmq's own options, documented by bullmq.
Restating them here would only produce a staler copy.

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

The trade: **a worker set to `0` will not ride out a Redis blip.** Raise it if that
matters more than a clean exit on a cold start against an absent Redis. They
cannot both be had until Bun clears the timer on `close()`.

## Publish side and worker side are different processes

`QueueModule.forRoot()` binds three tokens: `QueueOptions`, `QueueConnection` and
`JobPublisher`. That is the **publish** side, which is all a web process needs.

**Importing it opens no worker and consumes nothing.** A web process that
publishes never consumes by accident. Consuming is a deliberate second step:
either `WorkerFactory.create` in its own process, or `WorkerFactory.attach`
inside a container that already exists. Either way, the two sides agree on
exactly one thing: the module.

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

A queue is opened on **first use**, not declared up front: a queue is a key prefix,
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

The root module it is handed may be the app's own or a narrower one that leaves
the controllers out. It is a normal dunx container either way, so a handler gets
the same constructor injection a controller does.

**`create` discovers and validates; `start` is what opens connections.** So a
wiring mistake fails before anything consumes, and `worker.jobs` can be inspected
in a test with no server running:

| Mistake                              | Error at `create`                                                       |
| ------------------------------------ | ----------------------------------------------------------------------- |
| No `QueueModule` in the graph        | `ERR_QUEUE_INVALID_STATE`                                               |
| No marked method anywhere            | `ERR_QUEUE_NO_HANDLERS`                                                 |
| A name in `queues` no handler claims | `ERR_QUEUE_NO_HANDLERS`, naming both what is missing and what was found |
| Two handlers on one `(queue, name)`  | `ERR_QUEUE_DUPLICATE_HANDLER`                                           |

The `QueueModule` check reads the **module graph**, not the container, on purpose:
`QueueOptions` is a class whose constructor argument is optional, so an unbound
container would self-bind it and hand back defaults. A worker silently pointed at
`localhost` is worse than one that will not boot.

`WorkerApp` carries `jobs` (every handler after the filter), `queues` (what this
process will consume), `start()`, `shutdown()`, `enableShutdownHooks()`, `closed`
and `get(token)`.

### One queue, one process

```ts
const worker = await WorkerFactory.create(AppModule, { queues: ['emails'] });
```

That is how one queue gets its own process and its own concurrency. A name in that
list that no handler claims is a boot error, rather than a process that quietly
serves only the queues that were spelled right.

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

`root` is the same module ref the app was built from. The handlers are found by
inspecting it, and resolved out of the container that is already running.

It returns a **`QueueConsumer`**, which is the consuming half of
`WorkerFactory.create` with no `App` of its own: `jobs`, `queues`, `start()` and
`stop()`. `create` now wraps the same class, so the two paths share their
behaviour rather than merely resembling each other.

`attach` validates with exactly the same rules as `create`. No handlers, or a
named queue nothing consumes, are both boot errors. The difference is what happens
on failure: `attach` leaves the caller's container running, because it does not
own it.

### Stop the consumer before you shut the app down

This is the sharp edge, and it deserves saying plainly.

```ts
await consumer.stop();
await app.shutdown();
```

`consumer.stop()` closes the workers and **nothing else**. It is idempotent, and
it waits for whatever is mid-flight, because `close()` without `force` stops
fetching and waits for what is already running.

**Nothing can enforce that ordering.** Core's `App` exposes no hook to register
against, so `attach` cannot arrange to run first, and a worker still running when
providers tear down finds its database connection closed underneath it.

A worker **process** gets the ordering for free, because `WorkerApplication` owns
the container and its `shutdown()` runs `consumer.stop()` before
`app.shutdown()`. An attached consumer does not, so the caller has to sequence it.

Which to reach for:

- **A separate worker process** when the two halves should scale, fail and deploy
  independently, or when a slow handler must not compete with request latency.
  `examples/full` does this, and it is why that example has a `bun run worker`.
- **`attach`** when one process is the whole deployment: a small service, a
  single container, or a job whose handler is cheap enough that the isolation is
  not worth a second process.

## `jobTimeoutMs`

The one behaviour here that bullmq does not already own.

bullmq has `lockDuration` and stall detection, which answer _did the worker die_,
not _is this handler stuck_. A handler hung on an external call holds its lock,
renews it, and never finishes. `jobTimeoutMs` rejects it with
`ERR_QUEUE_TIMED_OUT` so the job fails and retries under its own `attempts`. Off
by default.

## Shutdown

`worker.shutdown()` closes every bullmq `Worker` **before** the container tears
down. That order is the point: `close()` without `force` stops fetching and waits
for what is already running, so an in-flight job finishes while the database
connection it is using is still open.

The container's own reverse-construction-order teardown then closes the
publisher's queues, and last of all the sockets. `QueueConnection` is constructed
first, because everything else needs it, so it goes last.

`enableShutdownHooks()` wires `SIGTERM` and `SIGINT` to that sequence.

## The ioredis boundary

Rule 1 bans `ioredis` for dunx's own code, because `Bun.RedisClient` exists.
bullmq needs _a_ Redis client. The resolution is not a compromise, and it was
found by measuring rather than by assuming.

**Every byte of queue traffic goes through `Bun.RedisClient`.** bullmq accepts
either a connection description it builds a client from, or an already-built
client implementing its `IRedisClient` interface, and bullmq 6 ships
`createBunRedisClient`, an adapter over Bun's client. `QueueConnection` uses it.
dunx neither imports nor constructs ioredis, and `dist/` contains no reference to
it.

Verified on bullmq 6.0.5, Bun 1.3.14 and Redis 8.4.0, over that adapter, in 0.5 s:
concurrency 5 honoured across 20 jobs, `attempts: 2` with fixed backoff retrying a
throwing handler exactly once, a delayed job reporting state `delayed` and
arriving, and `worker.close()` waiting 244 ms for a 250 ms handler rather than
dropping it.

Three findings shaped the code:

- **ioredis is a load-time requirement of bullmq, in both its builds.**
  `utils/index` and `classes/redis-connection` statically import `ioredis` and
  `ioredis/built/utils`, so `import { Queue } from 'bullmq'` throws
  `Cannot find module` without it, despite bullmq 6 declaring `ioredis` an
  _optional_ peer and shipping three other backends. That is the only reason it is
  listed as an optional peer of `@dunx/infra`. If bullmq makes that import lazy,
  the entry disappears.

  It is optional in the same sense `bullmq` is - needed if and only if you use
  `/queue` - which is why `bun add bullmq ioredis` installs the pair. Any version
  from 5.0.0 works, because that is the range bullmq itself declares and dunx has
  no opinion beyond it.

- **bullmq does not close a connection it was handed.** Measured with
  `CLIENT LIST`: four connections live, three after `worker.close()` plus
  `queue.close()`. It closed only the duplicate it created itself.
  `QueueConnection.onShutdown` closes the rest.
- **Closing one afterwards emits `error` on an emitter with no listener**, because
  bullmq detaches its own handler on close and Node's `EventEmitter` throws for an
  unhandled `error`. Shutdown would fail on its last step. The adapter gets a no-op
  `error` listener at construction.

One client is opened **per bullmq object** rather than one shared, because a
`Worker` blocks on `BZPOPMIN` and bullmq duplicates whatever it is given to get a
connection it may block on. Sharing would only add a duplicate.

`@dunx/infra/redis` is untouched and unshared: a queue's sockets are its own. See
`packages/infra/README.md` for the Redis client itself.

### The subpath is the only way in

`@dunx/infra/queue` is deliberately **not re-exported from the package barrel**,
unlike every other area. `src/index.ts` re-exporting it would put bullmq's static
`ioredis` import behind `import '@dunx/infra'` for every consumer, queue or no
queue.

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

## Related

- [Configuration](./11-configuration.md) for `forRootAsync` and `AppConfigService`
- [Logging](./12-logging.md), which the worker uses for job completion and failure
- `examples/full`, whose `src/worker.ts` is the worked example this page is drawn
  from
