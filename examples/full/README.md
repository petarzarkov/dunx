# @dunx/example-full

One long-running backend service that uses every part of dunx, so you can open it
and poke at it rather than read about it.

**Start smaller if this is your first look.** [`examples/minimal`](../minimal) is
five files and two minutes; [`examples/databases`](../databases) is database setup
on four configurations; [`examples/testing`](../testing) is the test story. This one
is the answer to "does it all actually compose?" It is the only example where
that is visible.

```bash
bun install
bun run --filter '@dunx/example-full' start
```

Then open **<http://localhost:3000/api/docs>** - the swagger page is generated from
the same zod schemas the routes validate against, so every endpoint below is
listed, typed and callable from the browser.

| Where                    | What                                            |
| ------------------------ | ----------------------------------------------- |
| `/api/docs`              | the API reference, self-contained, no CDN       |
| `/api/openapi.json`      | the OpenAPI 3.1 document it renders             |
| `/assets/`               | a static directory, on `Bun.file`               |
| `/api/health/live`       | liveness - is this process working              |
| `/api/health/ready`      | readiness - should it receive traffic           |

It stays up until you stop it. `ctrl-c` drains in reverse construction order: the
services first, then the database and the temp directory they were using.

## Two entrypoints

| Command         | Does                                                                |
| --------------- | -------------------------------------------------------------------- |
| `bun start`     | serves on `PORT` (default 3000), **consumes its own queues**, holds  |
| `bun run dev`   | the same, under `bun --watch` - reloads on every save                |
| `bun run tour`  | boots the same app, narrates every package, shuts down, exits 0      |

The tour is what CI runs. It is the end-to-end check that the whole DI graph builds
and that every package still does what its comments claim. `bun start` cannot be
that check, because a service never exits.

## What is mounted

| Routes            | Exercises                                                              |
| ----------------- | ------------------------------------------------------------------------ |
| `/api/users`      | `@dunx/http` - zod on params, query and body; 201 from the verb         |
| `/api/notes`      | the global prefix, middleware, CORS                                     |
| `/api/ledger`     | `@dunx/infra/db` - drizzle over `bun:sqlite`, seeds, transactions        |
| `/api/files`      | `@dunx/infra/files` - `Storage`, globbing, traversal refusal, presign    |
| `/api/images`     | `@dunx/infra/images` - `Bun.Image` resize and re-encode                  |
| `/api/cache`      | `@dunx/infra/redis` - `Bun.RedisClient`, degrading when nothing is up    |
| `/api/reports`    | `@Public`, `@Roles` and `@UseGuards`                                    |
| `/api/health/*`   | `HealthModule` - liveness, readiness, and a drain before the port closes |
| `/api/limits`     | `@Throttle`, `@SkipThrottle` and a Redis-backed counter                 |
| `/api/upstream`   | `@dunx/http/client` - the outbound half, with retry and a 404           |
| `/assets/*`       | `StaticFiles` - two cache policies and a traversal refusal              |
| `/api/jobs`       | `@dunx/infra/queue` - bullmq; published and consumed by this process       |
| `/api/auth/*`     | `@dunx/auth` - better-auth mounted, with `Bun.password` hashing          |
| `/api/wiring`     | `@dunx/core` - `token()`, `inject()` and the three `provide()` shapes    |
| `/chat`           | a websocket gateway on the **same** `Bun.serve` as the routes            |

### Things worth trying

```bash
# The transaction is one unit. `fail` throws between the two inserts, and the
# row count in the 409 is unchanged - proof the first leg was rolled back.
curl -s localhost:3000/api/ledger
curl -sX POST localhost:3000/api/ledger/transfer -H 'content-type: application/json' \
  -d '{"from":"checking","to":"savings","amount":25,"fail":true}'

# Storage refuses to leave its root, before any syscall.
curl -s 'localhost:3000/api/files/object?key=../../etc/passwd'

# An image Bun.Image grows at runtime from a 4x4 seed. No binary is checked in.
curl -s 'localhost:3000/api/images/render?width=128&format=webp' -o thumb.webp

# The guard is on ReportsController, not global, so only these need credentials.
curl -s localhost:3000/api/reports                                  # 401
curl -s localhost:3000/api/reports -H 'authorization: Bearer viewer'  # 200

# Four checks, run concurrently, each bounded by timeoutMs. `redis` is the only
# one that may be down, and it is the only non-critical one.
curl -s localhost:3000/api/health/ready
curl -s localhost:3000/api/health/live

# Three per minute, per subject. The fourth answers 429 with retry-after.
for i in 1 2 3 4; do
  curl -s -o /dev/null -w '%{http_code} ' -H 'x-api-key: me' \
    localhost:3000/api/limits/burst
done

# max-age=60 on a name that can change, immutable on a content-addressed one.
curl -sI localhost:3000/assets/site.css        | grep -i cache-control
curl -sI localhost:3000/assets/app.a1b2c3d4.js | grep -i cache-control
```

`ctrl-c` shows the ordering that makes readiness worth having: `/api/health/ready`
starts answering `503` while the port is still open, waits `drainDelayMs`, and only
then does the socket close. `/api/health/live` keeps answering `200` throughout, so
nothing decides to restart a pod that is already leaving.

`bun run tour` also boots a **second node** for `/chat`: a second `Bun.serve`
and a second container in the same process. It relays a publish between the
two through Redis, asserting one delivery per client.

Node A relays with `@dunx/http`'s `RedisRelay`; node B relays through the app's
own `@dunx/infra/redis` connection, which satisfies `PubSubRelay` structurally.
With no Redis running it says it is skipping and the app still exits 0.

### The queue needs two processes

### Where a handler runs

`bun start` works the queues as well as serving them. There is no second command,
and **nothing in `main.ts` says so**: `JobsModule` sets `consume: true` on its
`QueueModule`. The container starts the workers at `onInit` and stops them at
`onShutdown`, before the database they use closes.

A queue runs in a **forked child** when a handler asks for one:

```ts
@JobHandler({ queue: 'thumbnails', name: 'render', background: true })
async render(job: Job<RenderRequest>): Promise<RenderResult> { ... }
```

The boot log says which each queue got:

```
Started [background] worker for queue: thumbnails
  handlers: render: ThumbnailJobs.render
  worker:   { isolation: process }
```

Leave `background` off and the queue runs on this event loop - `[foreground]`,
cheapest, right for a handler that does nothing slow. A queue marked `background`
with no `processor` configured is a boot error rather than a silent demotion.

Enqueue one and watch a single stream:

```bash
curl -X POST localhost:3000/api/jobs/thumbnails -H 'content-type: application/json' -d '{}'
# pid=79934  POST /api/jobs/thumbnails 201        <- the server
# pid=80222  Sandboxed worker ready, 1 handler(s) <- the child, first job only
# pid=80222  rendered job 58                      <- the handler, in the child, here
```

Different pid, same stream. `job.log()` puts the same lines **on the job**, where
bull-board shows them - the copy that outlives the process.

`src/jobs/jobs.processor.ts` is the file the child runs. Three lines, because
`JobProcessor` does the rest.

```bash
# Returns immediately with a job id. `bun start` is already consuming.
curl -sX POST localhost:3000/api/jobs/thumbnails \
  -H 'content-type: application/json' -d '{"width":128,"format":"webp"}'

# Poll it. `result` is whatever the handler returned, computed in the child.
curl -s localhost:3000/api/jobs/thumbnails/1
```

The handler in [src/jobs/thumbnail.jobs.ts](./src/jobs/thumbnail.jobs.ts) injects the
same `Thumbnails` service the HTTP image routes use - one wiring, two entry points.
`@JobHandler` is the whole registration; the runner finds it by walking prototypes,
the same discovery routes and gateways use.

**With no Redis the queue routes answer 503 in single-digit milliseconds**
rather than hanging. One caveat before deploying anything shaped like this: a
process that *attempted* a queue operation while Redis was down will not exit
on `SIGTERM`, because bullmq holds a connection whose retry timer outlives
`close()`.

Importing the module is not enough to trigger it, and a healthy Redis is
unaffected. Measured, with the table in
[docs/bun-apis.md](../../docs/bun-apis.md).

## Configuration

Every setting goes through one validation function - `validate` in
[src/config.ts](./src/config.ts) - and nothing downstream reads `process.env`. Bun
loads `.env` and `.env.local` itself, so there is no loader and no `dotenv`.

| Variable        | Default                 | Effect                                   |
| --------------- | ----------------------- | ------------------------------------------ |
| `PORT`          | `3000`                  | where it listens                          |
| `LOG_LEVEL`     | `info`                  | `verbose`…`fatal`                         |
| `LOG_FILE`      | _unset_                 | also append rotating JSON to this path    |
| `DATABASE_FILE` | `:memory:`              | a path makes the ledger survive restarts  |
| `REDIS_URL`     | Bun's own default chain | absent is fine - the cache routes say so  |
| `CORS_ORIGIN`   | `https://example.com`   | the allowed origin                        |
| `IMAGE_QUALITY` | `82`                    | encoder quality                           |
| `THROTTLE_LIMIT` | `1000`                 | app-wide requests per window, per subject |
| `SCHEDULE_TZ`   | `UTC`                   | zone for a `@Cron` that names none        |
| `UPSTREAM_TIMEOUT_MS` | `5000`            | per-call budget for outbound requests     |

A clean checkout boots with none of them set.

## Degrading rather than failing

`bun start` works with nothing installed. The database is `:memory:` and storage is
a temp directory, so both are always live. Redis is the one area that can be down,
and when it is, `/api/cache/*` answers **503 with the connection error's own
message** while `/api/health/ready` still answers `200 up`. A cache that is not
running is not a reason for the service to refuse to start, or to be pulled out of
rotation.

That is `critical: false` on one indicator, not a special case:
[src/health/indicators.ts](./src/health/indicators.ts) subclasses `RedisIndicator`
to flip it. `database` and `ledger` stay critical, so a broken database does shed
traffic.

```bash
REDIS_URL=redis://127.0.0.1:1 bun run tour   # still exits 0
```

## Scheduled work

`@Cron`, `@Interval` and `@OnceOnBoot` in
[src/schedule/maintenance.service.ts](./src/schedule/maintenance.service.ts), armed at
boot by `ScheduleModule`. The runner finds them by walking the prototype chains of
the classes the modules already declare, so none needs a second registration.

In-process and single-node: two replicas both run every schedule, because nothing in
`@dunx/infra/schedule` coordinates. Work that must happen once across a fleet is a
job, which is `@JobHandler` and bullmq.

`ScheduleRegistry.trigger(name)` runs one off its own cadence, which is how the tour
exercises a 03:00 cron without waiting for 03:00.

`keepAlive: false` here, unlike the default: `Bun.cron` holds the event loop open, and
`bun run tour` has to exit.

## Logging

`@dunx/http` writes the entry. `requestLogging` in
[src/main.ts](./src/main.ts) is all this app configures: the bodies come
from `LOG_REQUEST_BODY` and `LOG_RESPONSE_BODY`, and `/api/_dunx` is skipped.
Nothing here writes a request line by hand;
[src/http/request-trail.ts](./src/http/request-trail.ts) is a middleware of the
app's own that records a trail and sets a header.

**One entry per request, not two.** The usual `RequestMiddleware` +
`HttpLoggingInterceptor` pair logs on the way in and again on the way out, because
the two halves are different classes. dunx has no interceptors and needs none:
middleware wraps `next()`, so the request and its response go out together:

```json
{
  "level": "info",
  "message": "POST /api/ledger 201",
  "requestId": "trace-9",
  "method": "POST",
  "event": "/api/ledger",
  "flow": "http",
  "context": "LedgerController.create",
  "request": { "body": { "memo": "latte", "amount": -4 }, "userAgent": "curl/8.5.0" },
  "statusCode": 201,
  "responseBody": { "id": 3, "memo": "latte", "amount": -4 },
  "elapsedMs": 5
}
```

One line to grep, one line to ship, and no correlating a pair by `requestId` to
find out how a call ended. A 4xx is the same line at `warn`, a 5xx at `error`.

Everything the *handler* logs in between still carries `requestId`, `method`,
`event` and `context` without being passed anything, because `ContextStore` is an
`AsyncLocalStorage`. An inbound `x-request-id` is honoured so a trace survives
across services; otherwise one is minted and returned on the response.

An unmatched path is logged too. Bun answers a miss itself, and the middleware
chain would never see it, so `@dunx/http` installs one `fetch` fallback that puts
the global middleware in front of a `{"error":"NOT_FOUND","status":404}`. Bun is
still the router.
