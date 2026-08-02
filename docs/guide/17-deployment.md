# Deployment

A dunx app is a Bun process that calls `Bun.serve`. There is no adapter to pick,
no build step that rewrites your code, and nothing that has to run before the
process starts except the one preload line.

## The one thing that must survive to production

```toml
# bunfig.toml
preload = ["@dunx/transform/preload"]
```

`@dunx/transform` records each class's constructor parameter types when the file
loads. Without it the container has no way to know what a constructor wants, and
boot fails with an error naming the class rather than constructing it with
`undefined` arguments. That is deliberate, and it means a deployment that loses
`bunfig.toml` fails immediately and loudly rather than at the first request.

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
process open. There is no cluster module to configure - see the note on
horizontal scaling below.

## Shutting down cleanly

```ts
const app = await HttpFactory.create(AppModule);
app.enableShutdownHooks();

await app.listen(3000);
await app.closed;
```

`enableShutdownHooks()` installs the signal handlers. On `SIGTERM` or `SIGINT`
the graph is torn down in **reverse construction order**, so a repository is
disposed before the database connection it holds, and `app.closed` resolves once
that finishes. Anything implementing `OnShutdown` participates.

This matters more than it looks under an orchestrator. Kubernetes sends
`SIGTERM` and then waits `terminationGracePeriodSeconds` before `SIGKILL`; a
process that ignores the first signal loses whatever was in flight.

One known defect, recorded in [ROADMAP.md](../ROADMAP.md): **a process that
attempted a Redis operation against a server it could not reach does not exit on
`SIGTERM`**. Two upstream leaks produce it, and neither is reachable from
userland - a `Bun.RedisClient` whose TCP connect never completes keeps a handle
past `close()`, and bullmq's Bun adapter cannot cancel its own reconnect timer
once the connection has dropped. Serving is unaffected and a healthy Redis is
unaffected; it is a shutdown defect only. If you deploy against a Redis that may
be down at the time, set a grace period short enough that `SIGKILL` arrives
promptly.

## Configuration

Bun reads `.env` and `.env.local` itself, so there is no loader to configure and
no `dotenv` to install. In a container you will normally set real environment
variables instead and ship no `.env` at all.

Validation happens once, at boot, through the single function you gave
`ConfigModule.forRoot`. A missing or malformed variable fails the process before
it serves anything, which is the behaviour you want from an orchestrator's
perspective: a bad config becomes a failed rollout rather than a running service
returning 500s. See [Configuration](./11-configuration.md).

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

Give the orchestrator a route that answers without touching anything that can be
slow:

```ts
@Controller('health')
export class HealthController {
  @Get('/')
  live(): { status: string } {
    return { status: 'ok' };
  }
}
```

Keep readiness separate from liveness if you have dependencies that can degrade.
`examples/full` has a health controller that reports each area as live or
degraded, which is the shape to copy: a cache being down should not restart the
process, and a liveness probe that checks Redis will do exactly that.

## Logging

Request logging is on by default and writes one structured line per request,
carrying the request and the response together. In a container that is what you
want: stdout, one JSON object per line, collected by whatever is running.

`ConsoleLogger` batches `info` and below into a single write per event-loop turn.
`warn`, `error` and `fatal` are never buffered and flush everything queued ahead
of them, so ordering is preserved and the entries you go looking for after a
crash are the ones that were never held back. A buffered `info` line can be lost
if the process dies without unwinding - a `SIGKILL` or an OOM kill. If you need
every line, construct the logger with buffering off:

```ts
provide(Logger, { useValue: new ConsoleLogger(context, LogLevel.INFO, false) });
```

For redaction, rotation and file transports, bind `LoggerModule` from
`@dunx/infra/logger`. See [Logging](./12-logging.md).

## Horizontal scaling

Nothing in dunx holds cross-request state, so running N processes behind a load
balancer works with no changes. Two things need attention when you do:

- **WebSocket fan-out is per process.** `socket.subscribe(topic)` joins a topic
  in the Bun runtime of that process only, so a publish reaches the clients
  connected to that instance. Attach the Redis relay to fan out across nodes -
  see [WebSockets](./08-websockets.md).
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

Eager resolution is a deliberate trade: every provider is constructed at boot, so
a missing binding or a bad config is a failed start rather than a 500 on the
first request that happens to need it.
