# @dunx/dashboard

One page over a running dunx app: the routes it serves, the container it built,
the gateways it upgrades, Redis, the config keys and the process itself - **with
bull-board mounted for the queues**. Opt in with one module and one `app.use`.

```bash
bun add @dunx/dashboard
```

An operator looking at a running dunx service has had three surfaces over the same
data and none of them the one they wanted. `/docs` answers "what can a client
call". `@dunx/mcp` answers the same questions for an agent, over stdio. Nothing
answered **"what is this process actually doing"**. This is that page, and it is
cheap because every panel reads data dunx already computes.

## Mount it

```ts
import { DashboardMiddleware, DashboardModule } from '@dunx/dashboard';
import { JobPublisher, QueueModule } from '@dunx/infra/queue';
import { RedisConnection, RedisModule } from '@dunx/infra/redis';

@Module({
  imports: [
    DashboardModule.forRootAsync({
      // This dynamic module is its own scope, so whatever exports the tokens the
      // factory injects goes here.
      imports: [QueueModule, RedisModule],
      useFactory: (queues: JobPublisher, redis: RedisConnection) => ({
        queues,
        redis,
        authorize: (req) => req.headers.get('x-ops-key') === process.env.OPS_KEY,
      }),
      inject: [JobPublisher, RedisConnection] as const,
    }),
  ],
})
export class AppModule {}
```

```ts
const app = await HttpFactory.create(AppModule);
app.use(DashboardMiddleware, SessionGuard); // the dashboard first - see below
await app.listen(3000);
```

That is the whole wiring. `JobPublisher` and `RedisConnection` are accepted **as
they are**: this package restates what it needs from them structurally and depends
on `@dunx/infra`, `bullmq` and `ioredis` not at all, so an app with no queues does
not install a queue library to look at its routes.

## Six panels

| Panel                   | Reads                                                                              | Lifetime |
| ----------------------- | ---------------------------------------------------------------------------------- | -------- |
| **Overview**            | counts, uptime, heap, Bun version, dependency probes                              | polled   |
| **Routes**              | `routesOf` - method, path, controller, module, guards, `@Roles`/`@Public`, schemas | static   |
| **Gateways**            | `gatewaysOf` - upgrade path, the event each handler claims                         | static   |
| **Modules & providers** | `providersOf`, `modulesOf` - what each module binds, exports and injects           | static   |
| **Queues & Redis**      | queue names and a link to **bull-board**; Redis `PING` and `INFO`                 | polled   |
| **Configuration**       | keys and types, values only where you allow them                                   | static   |

The provider panel is the one that earns its place fastest. A missing-binding error
names one token; reconstructing which module bound what and why the graph did not
close is otherwise a grep across every `@Module`. An **unresolvable constructor
parameter** - an interface, a primitive, a union, a type-only import - is called out
in red on the overview, because each one is a boot error waiting to happen.

The static panels use the same readers `@dunx/mcp` answers with, and they construct
nothing. That is the deliberate inversion of MCP's rule: MCP refuses runtime
questions because booting an app to answer them would open databases and bind
sockets, and this package is *already inside* a booted app, so the reason does not
apply. Stating it per panel is what stops the dashboard growing a `boot()`.

## Every panel has a JSON sibling

```bash
curl -H 'x-ops-key: …' $APP/_dunx/api/snapshot
curl -H 'x-ops-key: …' $APP/_dunx/api/runtime
curl -H 'x-ops-key: …' $APP/_dunx/api/redis
curl -H 'x-ops-key: …' $APP/_dunx/api/queues     # names only; the board is at /_dunx/queues
```

These are the endpoints the page itself uses, and they are supported rather than an
implementation detail - which is what makes the dashboard usable on a box with no
browser. Their types are exported (`Snapshot`, `RuntimeReport`, `RedisReport`,
`QueuesReport`), so a `fetch` of them is typed. Anything *about* a queue is
bull-board's own API, under `{path}/queues`.

## Security

**`authorize` has no default. Leaving it out serves the page to anyone who can
reach the port**, and the page is routes plus config plus the provider graph on one
screen - a reconnaissance gift. Omitting it logs a warning naming the mount at boot,
because "fine behind a private network" is a real answer and guessing is not.

Four things follow, and none is obvious:

- **A rejected request gets 404, not 403.** A dashboard that announces itself to an
  unauthenticated caller has told them where to keep knocking.
- **Register it ahead of any session guard.** With the middleware last in the chain,
  a `SessionGuard` answers every dashboard request `401` before `authorize` runs,
  which defeats the 404 contract entirely.
- **So `authorize` must be self-sufficient.** It receives the raw `Request` and runs
  before anything has written an `AuthContext` - ask your auth library directly.
- **`commands: false`** puts bull-board in its own read-only mode. Everything else
  on the page only ever reports, so this is entirely about the queues. `authorize`
  gates who reaches the mount; this gates what they can do once there.

### Configuration is redacted by default

`ConfigService` holds whatever your `validate` returned, which includes every secret
you have. A deny-list of the usual suspects - `SECRET`, `PASSWORD`, `TOKEN` - looks
careful and leaks the first key nobody thought of, so **the default reveals
nothing**: the panel shows keys and types, which is most of what it is wanted for,
and a value appears only where you say so.

```ts
config: appConfig,           // ConfigService satisfies this as written
reveal: (key) => key === 'NODE_ENV' || key.startsWith('PUBLIC_'),
```

There is no "reveal" control on the page. Redaction is decided at boot by the app,
not per click by whoever reached it.

## The queues are bull-board's

**dunx renders no queue UI.** `{path}/queues` is
[bull-board](https://github.com/felixmosh/bull-board), mounted - flows, job logs,
the repeatable-job editor, per-queue metrics, redis stats, retry/promote/clean, all
of it, and none of it dunx's to maintain.

This package briefly shipped its own queue table, and that was the wrong call under
the framework's first rule: never invent what a mature library already solves. The
one thing that had ever justified hand-rolling it was that mounting bull-board on
`Bun.serve` meant writing a server adapter - which the deleted
`@dunx/queue-dashboard` did, and which was a liability. **bull-board 8.6.0 ships
`@bull-board/bun`**, so that reason is gone and the integration is three calls.

It also disposes of the question that started all this: `Queue.getWorkers()` returns
`[]` on Bun, because bullmq matches workers by client name through `CLIENT LIST` and
its Bun adapter never names a connection. Whatever bullmq can report on Bun is
bull-board's to report. dunx is not in the business of papering over it, and a
dashboard that quietly worked around a library's limitation would be a worse place
to find out about it.

```bash
bun add @bull-board/api @bull-board/ui @bull-board/bun
```

All three are **optional peers**. Without them the queues panel says so and names
the install line; nothing else on the page is affected.

Two things dunx does contribute, and they are the two bull-board cannot know:

- **It is behind the same `authorize`** as the rest of the mount, and answers the
  same 404 to a caller that fails it.
- **`commands: false` maps onto bull-board's own `readOnlyMode`** rather than dunx
  refusing its POSTs. It already has the switch; a second implementation would
  disagree the moment bull-board grew an operation dunx had not heard of.

One caveat worth knowing: **bull-board's page loads a webfont from Google Fonts.**
dunx's own page fetches nothing, and that guarantee does not extend across the
handoff.

### Naming a queue this process only consumes

A queue is a key prefix opened on first use, so `JobPublisher.opened` lists only what
this process has **published** to. A worker that drains `thumbnails` and publishes
nothing has opened nothing, and the queue would be invisible on the page that exists
to show it:

```ts
queueNames: ['thumbnails'],
```

This is free. The board - and therefore any connection to the broker - is built on
the **first request for `{path}/queues`**, never at boot and never by the polling
`/api/queues` endpoint, which reads names straight off the options. An app that
mounts the dashboard and never opens the board holds no socket for it, which is what
lets a process still exit cleanly against an absent Redis.

## Options

| Option            | Default    | Notes                                                          |
| ----------------- | ---------- | -------------------------------------------------------------- |
| `path`            | `/_dunx`   | **`setGlobalPrefix` does not move it** - see below             |
| `authorize`       | *none*     | No default. See Security                                       |
| `title`           | `'dunx'`   | Header and `<title>`                                            |
| `queues`          | *none*     | `JobPublisher`                                                  |
| `queueNames`      | `[]`       | Queues this process only consumes                              |
| `redis`           | *none*     | `RedisConnection`                                               |
| `config`          | *none*     | `ConfigService`. Absent means no config panel                  |
| `reveal`          | reveal none| Per-key opt in                                                 |
| `probes`          | `[]`       | Anything else worth a light                                    |
| `openApiPath`     | *none*     | Links each route row into the explorer                         |
| `pollMs`          | `5000`     | `0` turns polling off and leaves the refresh button            |
| `probeTimeoutMs`  | `2000`     | A hung probe costs one light, not the page                     |
| `commands`        | `true`     | `false` → bull-board's own `readOnlyMode`                      |

`app.setGlobalPrefix('api')` prefixes routes discovered from controllers. The
dashboard is a **middleware matching a path**, not one of those - which is exactly
what lets it serve a route table handed over at runtime without generating a
controller per panel. With a global prefix, say so:

```ts
path: '/api/_dunx',
```

## Probes

Anything with a name and a `check()`. It is awaited with a timeout and never allowed
to throw into a response, so a hung dependency costs one light rather than the page -
and a probe that did not answer reads `unknown`, never `down`, because those are
different facts and one of them sends somebody to restart a healthy service.

```ts
probes: [
  {
    name: 'database',
    check: async () => {
      await db.execute(sql`select 1`);
      return { state: 'up', detail: 'sqlite' };
    },
  },
],
```

Passing `redis` adds one automatically, on `PING` rather than the connected flag: a
flag says a socket is up and a round trip says the server is answering.

## The page

Server-rendered shell, React + Mantine inside it, **inlined** - no CDN, no `src=`,
no `<link>`, so it opens on a host with no egress. It shares its theme and
components with the dunx documentation site and the API explorer, so the three look
like one product.

The bundle sits behind `@dunx/dashboard/ui` and is reached with `await import()` on
the first request for the page, so an app that mounts the module and never opens it
pays nothing at boot. It is built by `internal/dashboard-ui`.
