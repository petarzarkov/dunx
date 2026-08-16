# Queues

bullmq over `Bun.RedisClient`, and how the ioredis question resolved by measuring rather than by reasoning.

## Queues (`@dunx/infra/queue`)

**bullmq is the queue.** Never invent what a mature library solves, again: retries,
backoff,
priorities, rate limiting, delayed jobs, schedulers and stall recovery are bullmq's,
and a dunx implementation of any of them would be a worse one. `bullmq` is an
optional `peerDependency`. What the area contributes is the four things bullmq has
no opinion about - where a handler lives, how it is found, how it is injected, and
when it stops.

### The ioredis boundary, as it actually resolved

CLAUDE.md's "Where the two halves collide" anticipated ioredis arriving as bullmq's
internal engine and sanctioned it on the grounds that the ban is on _dunx_
reimplementing a Bun primitive. The measurement changed the answer for the better:

**bullmq 6 ships `createBunRedisClient`, an `IRedisClient` adapter over
`Bun.RedisClient`.** bullmq accepts either a connection description it builds a
client from, or an already-built client implementing that interface - so
`QueueConnection` builds `Bun.RedisClient` instances and hands them over
wrapped.

Every byte of queue traffic goes through Bun's client. dunx neither imports nor
constructs ioredis, and there is no shared socket with `@dunx/infra/redis`: a
queue gets one client per bullmq object, because a `Worker` blocks on
`BZPOPMIN` and bullmq duplicates whatever it is given to get a connection it
may block on.

Verified on bullmq 6.0.5 + Bun 1.3.14 + Redis 8.4.0, over that adapter, in 0.5 s:
concurrency 5 honoured across 20 jobs, `attempts: 2` with fixed backoff retrying a
throwing handler exactly once, a delayed job reporting state `delayed` and arriving,
and `worker.close()` waiting 244 ms for a 250 ms handler rather than dropping it.

Three findings that shaped the code:

- **ioredis is a load-time requirement of bullmq, in both its builds.** `utils/index`
  and `classes/redis-connection` statically import `ioredis` and
  `ioredis/built/utils`, so `import { Queue } from 'bullmq'` throws
  `Cannot find module` without it - despite bullmq 6 declaring `ioredis` an
  _optional_ peer and shipping three other backends. So `ioredis` is listed as an
  optional peer of `@dunx/infra` as well: declaring it is how a consumer's install
  produces something that works, and nothing in dunx reaches for it. If bullmq makes
  that import lazy, the entry disappears. Measured in full below.
- **bullmq does not close a connection it was handed.** Measured with `CLIENT LIST`:
  four connections live, three after `worker.close()` + `queue.close()` - it closed
  only the duplicate it created itself. `QueueConnection.onShutdown` closes the
  rest, and is bound as the first-constructed provider so reverse-order teardown
  runs it last.
- **Closing one afterwards emits `error` on an emitter with no listener**, because
  bullmq detaches its own handler on close and Node's `EventEmitter` throws for an
  unhandled `error`. Shutdown would fail on its last step. The adapter gets a no-op
  `error` listener at construction.

`@dunx/infra/queue` is **not re-exported from the package barrel**,
unlike every other area. `src/index.ts` re-exporting it would put bullmq's static
`ioredis` import behind `import '@dunx/infra'` for every consumer, queue or no
queue. The subpath is the only way in.

### Not pinning ioredis 5, because the reason to had three false premises

An earlier note here and in `docs/guide/15-queues.md` told readers to **pin ioredis
5**, on the grounds that bullmq's CJS build imports `ioredis/built/utils`, that
ioredis 6 removed it, and that only the ESM build was safe. Re-measured on bullmq
6.0.5 + ioredis 5.8.2 and 6.0.0 + Bun 1.3.14, **all three are wrong**:

- **ioredis 6.0.0 still ships `built/utils`** and still exports
  `CONNECTION_CLOSED_ERROR_MSG` from it (`built/utils/index.js:375`). Nothing was
  removed. Both 5.8.2 and 6.0.0 load bullmq's `Queue` from either build.
- **Both builds import it.** `dist/cjs/utils/index.js:25` and
  `dist/esm/utils/index.js:4`, plus `redis-connection` in each. There is no safe
  build.
- **The CJS build is the one Bun runs.** bullmq 6.0.5 declares no `exports` map and
  no `"type": "module"`, so the bare specifier resolves to `main`. The imported
  namespace carries `__esModule` and a `default` holding `Queue`, the CJS
  shape. The suite has been exercising the "unsafe" path all along and passing.

So the pin would have frozen a superseded major to avoid a failure that does not
happen. It is not applied, and the advice is removed from the guide and from
`bun-apis.md`.

What the error actually reports is **ioredis absent**, which is not fixable from
this side. `bullmq/dist/{cjs,esm}/classes/queue.js` both fail without it, because
everything routes through `utils/index`; only `classes/bun-redis-client.js` loads
standalone, and it is useless without `Queue` and `Worker`. So the barrel is not at
fault and there is no deep-import escape - **`/queue` cannot be imported without
ioredis, and cannot be made to be.**

`ioredis` nonetheless stays an **optional** peer, because it is optional in exactly
the sense `bullmq` is: needed if and only if `/queue` is used. Requiring it would
put ioredis in the install of every consumer of `/db`, `/files`, `/images`,
`/logger` and `/redis`, the outcome the ban exists to prevent. npm cannot
express "optional, but in lockstep with bullmq", so `packages/infra/src/index.test.ts`
does: one test asserts both peers carry `optional: true`, and guide 14 says
`bun add bullmq ioredis`.

The range is **bullmq's rather than dunx's**. dunx never imports ioredis, so it
has no opinion that could be better informed than the library that does, and
the peer therefore mirrors bullmq's own `>=5.0.0` rather than narrowing to the
major CI happens to resolve. The second test in that file asserts the two
ranges are equal, so bullmq changing its requirement fails here instead of
leaving dunx advertising a stale one - the same guard shape as the `LOG_LEVELS`
test.

The `devDependency` was `^6.0.0` against a `>=5.0.0` peer; it now matches the
peer, as `bullmq`'s and `drizzle-orm`'s already did.

### Job discovery

The **marker-plus-prototype-scan** technique from **Route discovery**, third use:
`@JobHandler({ queue, name })` sets a symbol property on the method function it
receives and returns it. Nothing accumulates at class-definition time, so there is no
ordering dependence and no cross-file leak. `WorkerFactory` walks
`Object.getPrototypeOf` from the prototype of each class the modules already declare
in `providers`/`controllers`, exactly as `discoverGateways` does.

What that buys, and it is the same list routes get: no second registration key, no
`@Processor` class decorator, an abstract base's handlers inherited by every
subclass, an undecorated override still dispatched to because the handler is bound
off the instance, and a duplicate `(queue, name)` as a boot error naming both
methods rather than traffic silently split between them.

One asymmetry with gateways is deliberate. `discoverGateways` throws when a class
declares a handler but is not marked `@Gateway`, because such a handler could never
receive a frame. There is no class-level marker here, so there is no such orphan
state and no such error.

A factory- or value-provided instance is **not** scanned. There is no class to read a
prototype chain from until it has been built, and building every factory provider to
find out whether it was worth building is the ordering trap the marker technique
exists to avoid.

### Publish and consume are different processes, so they are different objects

`QueueModule.forRoot()` binds the **publish** side only - `QueueOptions`,
`QueueConnection`, `JobPublisher` - so a web process importing it opens no worker.
`WorkerFactory.create(root)` is the consume side, and it is the same shape as
`HttpFactory.create`: boot the container, `collectModules(root)` for the graph,
discover by inspection, validate eagerly, and return an object wrapping `App` whose
`shutdown()` sequences its own resource ahead of the container's.

`create` discovers and validates; `start()` opens connections. That split is what
makes a wiring mistake - no `QueueModule`, no handlers, a misspelled name in
`queues` - fail before anything consumes, and what lets `worker.jobs` be asserted in
a test with no server running.

The "no `QueueModule`" check reads the **module graph** rather than the container, and the
reason generalises past queues: **every class self-binds, so a class whose
constructor arguments are all optional resolves successfully when nothing bound it.**
`app.get(QueueOptions)` on a container with no `QueueModule` returns defaults - a
worker silently pointed at `localhost` - rather than throwing. Any presence check for
a class-shaped token has the same hole; `collectModules(root)` and a token comparison
do not.

`JobPublisher` returns bullmq's own `Queue` and `Job` rather than wrappers, for the
same reason `/db` returns drizzle's database class: the library is the interface, and
a wrapper would be a surface to outgrow.

### The one behaviour that is dunx's rather than bullmq's

`jobTimeoutMs`. bullmq has `lockDuration` and stall detection, which answer _did the
worker die_ rather than _is this handler stuck_ - a handler hung on an external call renews
its lock and never finishes. The dispatcher races the handler against a timer and
clears it in a `finally`, since an uncleared timer would hold the loop open for its
full duration after a fast job. Off by default.

### Shutdown ordering

`WorkerApplication.shutdown()` closes every bullmq `Worker` first, then delegates to
`app.shutdown()` - the same reason `HttpApplication` stops the server before the
providers tear down. `close()` without `force` stops fetching and waits for what is
already running, so an in-flight handler finishes while the database connection it is
using is still open. The container's reverse-construction-order teardown then closes
the publisher's queues and finally `QueueConnection`'s sockets.

The integration suite asserts that order rather than just the outcome: a provider
injected into the handler records `container:shutdown` in its `onShutdown`, and the
test requires the sequence `slow:started`, `slow:finished`, `container:shutdown`,
plus zero open sockets afterwards.
