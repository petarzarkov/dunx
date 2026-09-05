# Deployment

A dunx app is a Bun process that calls `Bun.serve`. There is no adapter to pick
and no build step that rewrites your code. Nothing has to run before the process
starts except one preload line.

## The one thing that must survive to production

```toml
# bunfig.toml
preload = ["@dunx/transform/preload"]
```

`@dunx/transform` records each class's constructor parameter types when the file
loads. Without it the container has no way to know what a constructor wants, and
boot fails with an error naming the class rather than constructing it with
`undefined` arguments. A deployment that loses `bunfig.toml` fails immediately
and loudly rather than at the first request.

Three ways to supply it, all equivalent:

| Where           | How                                                |
| --------------- | -------------------------------------------------- |
| `bun run`       | `preload` in `bunfig.toml`, next to the entrypoint |
| A bundled build | `Bun.build({ plugins: [depsPlugin] })`             |
| A test          | `Bun.plugin(depsPlugin)` from a preload file       |

`node_modules` is skipped by the plugin: a published package was already
transformed by its own build, and re-parsing dependencies on every load is pure
cost.

## Running it

```bash
bun src/main.ts
```

That is the whole command. `HttpFactory.create` builds the container,
`listen()` hands the route table to `Bun.serve`, and the server holds the
process open. There is no cluster module to configure, see the note on
horizontal scaling below.

## HTTP/2

`http2: true` serves HTTP/2 on the same port as HTTP/1.1, through the same routes
and the same 404 fallback:

```ts
await HttpFactory.create(AppModule, { http2: true });
```

Without TLS that is h2c: a client opening with the HTTP/2 preface gets HTTP/2, and
everything else gets HTTP/1.1. That is what a reverse proxy in front of the app
speaks, which is the deployment this is for. Bun marks the option experimental.

What it is worth, at 64 requests in flight either way:

| Response          | HTTP/1.1   | HTTP/2     |          |
| ----------------- | ---------- | ---------- | -------- |
| 13 bytes          | 131k req/s | 378k req/s | **2.9x** |
| a small JSON body | 128k req/s | 365k req/s | **2.9x** |
| a 4 KiB POST      | 81k req/s  | 169k req/s | **2.1x** |
| 64 KiB            | 37k req/s  | 47k req/s  | **1.3x** |

The saving is per-request framing, so it shrinks as the body grows: turn it on for
an API serving small JSON, and expect little from it if you mostly serve large
payloads. Server CPU per request falls by the same ratios, so this is not an
artefact of the load generator.

Gateways keep working, because a websocket upgrade is an HTTP/1.1 request and both
protocols share the socket. There is no websocket over HTTP/2.

`http1: false` is the pair to it and refuses HTTP/1.x with a 505. **It disables
every gateway**, since nothing can then send the upgrade; dunx warns at boot if you
set it with a gateway declared. Only use it on a port that is HTTP/2 or nothing.

Bun's own `fetch` cannot call an h2c origin: `protocol: 'http2'` rejects with
`HTTP2Unsupported` against any cleartext peer, whatever that peer serves. Leave
`protocol` unset for a plain-HTTP upstream.

## Shutting down cleanly

```ts
const app = await HttpFactory.create(AppModule);
app.enableShutdownHooks();

await app.listen(3000);
await app.closed;
```

`enableShutdownHooks()` installs the signal handlers. On `SIGTERM` or `SIGINT`
the graph is torn down in **reverse construction order**, so a repository is
disposed before the database connection it holds. `app.closed` resolves once
that finishes, and anything implementing `OnShutdown` participates.

This matters more than it looks under an orchestrator. Kubernetes sends
`SIGTERM` and then waits `terminationGracePeriodSeconds` before `SIGKILL`; a
process that ignores the first signal loses whatever was in flight.

**It then ends the process.** Draining differs from exiting: one handle that
outlives teardown leaves a drained, idle process alive until `SIGKILL`, and that
handle is often not yours.

The real case is a Redis client. A `Bun.RedisClient` whose TCP connect never
completed keeps a handle past `close()`, and bullmq's Bun adapter cannot cancel
its own reconnect once the connection has dropped. An app that touched an
unreachable broker used to drain perfectly and then hang.

Both leaks are upstream and neither is reachable from userland. They are recorded
in [queue-shutdown-sigterm.md](../../internal/notes/roadmap/queue-shutdown-sigterm.md).

Once the drain finishes, dunx gives the process a moment to end on its own and
exits it if it has not. The timer is `unref()`d, so it cannot itself hold the
runtime open: a process with nothing pending exits immediately, and the pause is
only ever spent on a process that would otherwise have hung. A forced exit always
logs a line, since it means something leaked.

You no longer need a short `terminationGracePeriodSeconds` to work around this.

Pass `{ exitAfterMs: false }` to opt out. Pass it in **tests that fire a
signal at their own process**, too, or the forced exit lands in the middle of
your test run:

```ts
app.enableShutdownHooks(['SIGTERM'], { exitAfterMs: false });
```

## Configuration

Bun reads `.env` and `.env.local` itself, so there is no loader to configure and
no `dotenv` to install. In a container you will normally set real environment
variables instead and ship no `.env` at all.

Validation happens once, at boot, through the single function you gave
`ConfigModule.forRoot`. A missing or malformed variable fails the process before
it serves anything, so a bad config becomes a failed rollout rather than a
running service returning 500s. See [Configuration](./12-configuration.md).

## Container image

```dockerfile
FROM oven/bun:1.3-alpine
WORKDIR /app

# Dependencies first, so a source change does not reinstall them.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["bun", "src/main.ts"]
```

Two details worth getting right:

- **`--frozen-lockfile`**, so a deploy can never silently resolve a different
  version than the one that was tested.
- **`bunfig.toml` must be in the image.** It is easy to miss because it is not
  under `src/`. If your `.dockerignore` is written as an allowlist, add it
  explicitly.

`@dunx/transform` is needed at runtime under `bun run`, because the transform
happens on load. It is not a devDependency. If you bundle ahead of time with
`Bun.build` and the plugin, it becomes build-time only and can be dropped from
the image.

## Health checks

`HealthModule` from `@dunx/http` serves `/api/health/live` and `/api/health/ready`.

```ts
HealthModule.forRootAsync({
  useFactory: (db: DbConnection, redis: RedisConnection) => ({
    readiness: [
      new DatabaseIndicator(db),
      new RedisIndicator(redis, { critical: false }),
    ],
    drainDelayMs: 15_000,
  }),
  inject: [DbConnection, RedisConnection],
});
```

Do not hand-roll a controller for this. The part worth having is the drain, and a
plain controller cannot express it. Two settings decide whether a rollout drops
requests; the full mechanics, including how to write your own indicator, are in
[Health checks](./20-health-checks.md).

**`critical`** separates readiness from liveness. A `critical: false` indicator
reports `degraded` without failing the probe, so an absent Redis degrades a route
rather than restarting the process. Be sparing with `critical: true`: it should
name only what makes the process useless, which in most services is the database
alone. A liveness probe that checks Redis will restart a healthy process on a
cache blip.

**`drainDelayMs`** holds readiness failing before the port closes.
`Readiness` implements `OnBeforeShutdown`, which runs while the server is still
accepting, so the probe can answer "not ready" on an open socket for as long as
the load balancer needs to notice. An `onShutdown` hook runs after the server has
stopped, so a probe answering from there answers on a closed socket already.

Liveness keeps passing throughout: a pod that is shutting down does not need
killing.

Set `drainDelayMs` to at least your ingress's deregistration interval. The probes
are hidden from the OpenAPI document, so they will not appear in a generated
client.

## Logging

Request logging is on by default and writes one structured line per request,
carrying the request and the response together: stdout, one JSON object per line,
collected by whatever runs the container.

`ConsoleLogger` batches `info` and below into a single write per event-loop turn.
`warn`, `error` and `fatal` are never buffered and flush everything queued ahead
of them, so ordering holds and the entries you go looking for after a crash were
never held back.

A buffered `info` line can be lost if the process dies without unwinding, under a
`SIGKILL` or an OOM kill. If you need every line, construct the logger with
buffering off:

```ts
provide(Logger, { useValue: new ConsoleLogger(context, LogLevel.INFO, false) });
```

For redaction, rotation and file transports, bind `LoggerModule` from
`@dunx/infra/logger`. See [Logging](./13-logging.md).

## Horizontal scaling

Nothing in dunx holds cross-request state, so running N processes behind a load
balancer works with no changes. Two things need attention when you do:

- **WebSocket fan-out is per process.** `socket.subscribe(topic)` joins a topic
  in the Bun runtime of that process only, so a publish reaches the clients
  connected to that instance. Attach the Redis relay to fan out across nodes,
  see [WebSockets](./09-websockets.md).
- **Queue workers are separate processes.** `QueueModule.forRoot` binds the
  publish side alone, so a web process that publishes never accidentally starts
  consuming. Run workers with their own entrypoint and `WorkerFactory`.

## Cold start

Roughly twice raw `Bun.serve`, from the `oxc-parser` preload and eager dependency
resolution. It beats every Node framework measured here by a wide margin, but if
you are deploying somewhere that pays cold start per request, it is the number to
watch. The current figures are on the
[benchmarks page](https://petarzarkov.github.io/dunx/#/benchmarks), regenerated
from a real run rather than written down.

Eager resolution is a trade: every provider is constructed at boot, so a missing
binding or a bad config is a failed start rather than a 500 on the first request
that happens to need it.
