# @dunx/example-full

One long-running backend service that uses every part of dunx, so you can open it
and poke at it rather than read about it.

**Start smaller if this is your first look.** [`examples/minimal`](../minimal) is
five files and two minutes; [`examples/databases`](../databases) is database setup
on four configurations; [`examples/testing`](../testing) is the test story. This one
is the answer to "does it all actually compose?", and it is the only example where
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
| `/api/health`            | which areas are live and which are degraded     |

It stays up until you stop it. `ctrl-c` drains in reverse construction order: the
services first, then the database and the temp directory they were using.

## Two entrypoints

| Command         | Does                                                                |
| --------------- | -------------------------------------------------------------------- |
| `bun start`     | serves on `PORT` (default 3000) and holds                            |
| `bun run dev`   | the same, under `bun --watch` - reloads on every save                |
| `bun run worker`| consumes queued jobs - **a second process, on purpose**              |
| `bun run dev:worker` | the same, under `bun --watch`                                   |
| `bun run tour`  | boots the same app, narrates every package, shuts down, exits 0      |

The tour is what CI runs. It is the end-to-end check that the whole DI graph builds
and that every package still does what its comments claim - `bun start` cannot be
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
| `/api/health`     | which of the above are actually working                                 |
| `/api/jobs`       | `@dunx/infra/queue` - bullmq; publishes here, consumed by `bun run worker` |
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
```

`bun run tour` also boots a **second node** for `/chat` - a second `Bun.serve` and a
second container in the same process - and relays a publish between the two through
Redis, asserting one delivery per client. Node A relays with `@dunx/http`'s
`RedisRelay`; node B relays through the app's own `@dunx/infra/redis` connection,
which satisfies `PubSubRelay` structurally. With no Redis running it says it is
skipping and the app still exits 0.

### The queue needs two processes

A worker is its own container - its own connections, no HTTP server - so this is the
one area the service cannot demonstrate alone. Run both:

```bash
bun start          # publishes
bun run worker     # consumes, in another terminal
```

```bash
# Returns immediately with a job id and state "waiting".
curl -sX POST localhost:3000/api/jobs/thumbnails \
  -H 'content-type: application/json' -d '{"width":128,"format":"webp"}'

# Poll it. `result` is whatever the handler returned, computed in the worker.
curl -s localhost:3000/api/jobs/thumbnails/1
```

The handler in [src/jobs/thumbnail.jobs.ts](./src/jobs/thumbnail.jobs.ts) injects the
same `Thumbnails` service the HTTP image routes use - one wiring, two entry points.
`@JobHandler` is the whole registration; the worker finds it by walking prototypes,
the same discovery routes and gateways use.

**With no Redis the queue routes answer 503 in single-digit milliseconds** rather than
hanging. One caveat before deploying anything shaped like this: a process that
*attempted* a queue operation while Redis was down will not exit on `SIGTERM`, because
bullmq holds a connection whose retry timer outlives `close()`. Importing the module is
not enough to trigger it, and a healthy Redis is unaffected. Measured, with the table
in [docs/bun-apis.md](../../docs/bun-apis.md).

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

A clean checkout boots with none of them set.

## Degrading rather than failing

`bun start` works with nothing installed. The database is `:memory:` and storage is
a temp directory, so both are always live. Redis is the one area that can be down,
and when it is, `/api/cache/*` answers **503 with the connection error's own
message** and `/api/health` reports it `degraded`. A cache that is not running is
not a reason for the service to refuse to start.

```bash
REDIS_URL=redis://127.0.0.1:1 bun run tour   # still exits 0
```

## Logging

[src/http/request-log.ts](./src/http/request-log.ts) is the middleware, ported from
the usual `RequestMiddleware` + `HttpLoggingInterceptor` pair. dunx
has no interceptors and does not need them: middleware wraps `next()`, so one class
owns both halves.

**One entry per request, not two.** The two-component version logs on the way in and again
on the way out because the two halves are different classes. Here they are the same
closure, so the request and its response go out together:

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

An unmatched path is logged too. Bun answers a miss itself and the middleware chain
would never see it, so `@dunx/http` installs one `fetch` fallback that puts the
global middleware in front of a `{"error":"NOT_FOUND","status":404}` - Bun is still
the router.
