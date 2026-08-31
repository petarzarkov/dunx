# Logging

dunx logs every HTTP request by default, in an app that imported no logging
module at all, and it does that without `@dunx/core` taking a single
dependency.

## The contract lives in core

`Logger` is an **abstract class** in `@dunx/core`:

```ts
export abstract class Logger {
  abstract readonly logLevel: LogLevel;

  abstract verbose(message: string, ...optionalParams: unknown[]): void;
  abstract debug(message: string, ...optionalParams: unknown[]): void;
  abstract info(message: string, ...optionalParams: unknown[]): void;
  abstract warn(message: string, ...optionalParams: unknown[]): void;
  abstract error(message: string, ...optionalParams: unknown[]): void;
  abstract fatal(message: string, ...optionalParams: unknown[]): void;
}
```

An abstract class rather than an `interface`: `@dunx/transform` records
constructor parameter **types**, and an interface has no runtime value to
record. An interface here would be a boot error at every injection site. That is
the same trick `RequestContext`, `Storage`, `DbOptions` and `Auth` all use.

Inject it like anything else:

```ts
export class Notes {
  constructor(private readonly logger: Logger) {}

  create(title: string): void {
    this.logger.info('note created', { title });
  }
}
```

### Levels

`LogLevel` is a frozen object plus an indexed-access union rather than a
TypeScript `enum`. One exported name serves as both the value and the type:

```ts
import { LogLevel } from '@dunx/core';

LogLevel.VERBOSE; // 'verbose'
LogLevel.DEBUG; // 'debug'
LogLevel.INFO; // 'info'
LogLevel.WARN; // 'warn'
LogLevel.ERROR; // 'error'
LogLevel.FATAL; // 'fatal'
```

`LOG_LEVELS` is the same six in ascending severity, and position in that array is
what level filtering compares. Entries below the configured `logLevel` are dropped
before anything is serialised.

`log()` also exists and is **deprecated**. It emits `level: 'info'` either way. It
is kept only because the backing `@arkv/logger` keeps it to satisfy a third-party
`LoggerService` interface, and dropping it here would reject that class.

### Three call shapes

Every level accepts the same three:

```ts
logger.info('order placed', { orderId, total }); // message plus extras
logger.info({ orderId, total }); // fields merged into the entry
logger.info(err); // the error's message becomes the message
```

An `Error` among the extras becomes the entry's `error`. At `warn` and above, a
bare string or an `{ err }` / `{ error }` property is promoted to an error too.
That promotion is what `isErrorLevel(level)` reports.

## `ConsoleLogger`, the zero-dependency default

`AppFactory.create` offers a default binding for two tokens **after** every
module's own providers, so a module that binds either one wins:

| Token            | Default               | Replaced by                                       |
| ---------------- | --------------------- | ------------------------------------------------- |
| `Logger`         | `ConsoleLogger`       | `LoggerModule`, which binds `@arkv/logger`        |
| `RequestContext` | `AsyncRequestContext` | `LoggerModule`, which binds arkv's `ContextStore` |

They exist so `@dunx/http` can log every request without the app having imported
anything. Neither default reaches for a dependency: `ConsoleLogger` writes one
JSON line per entry, and `AsyncRequestContext` is `AsyncLocalStorage`, a Node
built-in Bun implements natively.

One line per entry, stdout below `warn` and stderr from `warn` up so a shipper can
separate them:

```json
{
  "level": "info",
  "timestamp": "2026-08-02T09:14:22.881Z",
  "pid": 4711,
  "message": "GET /notes 200",
  "requestId": "...",
  "statusCode": 200,
  "elapsedMs": 3
}
```

**What it does not do:** sanitize, mask, rotate, colour, or handle a cyclic
object. It calls `JSON.stringify` directly; a cycle in a log entry would be the
logger's fault, and the replacement that handles cycles is one import away.

That missing list is what `@dunx/infra/logger` buys.

### Buffering, and the durability trade

`ConsoleLogger` **batches `info` and below into one write per event-loop turn.**

A `console.log` per entry is a `write(2)` per entry. Measured, that was the
largest single component of request logging: **1.84 µs**, more than the
`JSON.stringify` that produced the line. Concatenating into one string and
writing it once per event-loop turn costs **0.27 µs**.

The trade matters: **a line still sitting in the buffer is lost if the process
dies without unwinding** - a `SIGKILL`, an OOM kill, a segfault - and a crash is
when the log is needed most.

Three things bound it:

- **`warn`, `error` and `fatal` are never buffered.** They go out immediately and
  **flush everything queued ahead of them**, so the entries you go looking for
  after a crash are the ones that were never held back.
- The window is **one event-loop turn** rather than a timer interval.
- `flush()` is public, `onShutdown()` calls it, and so does `process.on('exit')`.

Opt out entirely if you would rather have the syscall:

```ts
new ConsoleLogger(context, LogLevel.INFO, /* buffered */ false);
```

The buffer is module-level, shared by every `ConsoleLogger` instance, because they
all write to the same descriptor and separate buffers would interleave two
loggers' lines.

## `RequestContext` and `AsyncRequestContext`

The second contract in core. It is what carries `requestId` from the middleware
that minted it down to a service three constructor hops away, without anything
being passed:

```ts
export abstract class RequestContext {
  abstract getContext(): RequestFields;
  abstract updateContext(fields: Partial<RequestFields>): void;
  abstract runWithContext<T>(
    context: RequestFields,
    callback: () => T,
    options?: RunWithContextOptions,
  ): T;
}
```

`RequestFields` names the well-known keys a log pipeline can rely on -
`requestId`, `userId`, `method`, `event`, `context`, `flow` - and permits anything
else.

`AsyncRequestContext` is the default implementation, over `AsyncLocalStorage`,
with one departure from the built-in: **nested scopes merge.**

`AsyncLocalStorage.run` replaces the store outright, dropping the `requestId` an
outer scope established. `runWithContext` merges into a fresh object instead, so
an `updateContext` inside a nested scope does not leak back out. Pass
`{ inherit: false }` for the replacing behaviour.

```ts
export class Importer {
  constructor(private readonly context: RequestContext) {}

  async run(batchId: string): Promise<void> {
    await this.context.runWithContext(
      { flow: 'import', event: batchId },
      async () => {
        // every log line in here carries flow, event, and the caller's requestId
      },
    );
  }
}
```

`updateContext` is how you add a field to the scope you are already in, which is
how `@dunx/auth` puts `userId` on every line after a session is resolved.

## `LoggerModule`: swapping in `@arkv/logger`

`@dunx/infra/logger` binds core's contract to
[`@arkv/logger`](https://www.npmjs.com/package/@arkv/logger). dunx supplies the
contract and the wiring and **restates none of the configuration**.

```ts
import { Module } from '@dunx/core';
import { LoggerModule } from '@dunx/infra/logger';

@Module({
  imports: [LoggerModule.forRoot({ name: 'my-api', level: 'debug' })],
})
export class AppModule {}
```

No adapter class sits between them. `@arkv/logger`'s `Logger` already declares
`logLevel` and all six levels with the same overloads, so it satisfies the
contract structurally, and the binding is a `provide` with nothing in the middle.
The same holds for context: arkv's `ContextStore` satisfies `RequestContext`
structurally, so `LoggerModule` binds one to the other directly.

That last point is load-bearing rather than tidy. Without it, `@dunx/http`'s
request logging would write a `requestId` into core's default store while
`@arkv/logger` read its own, and no entry would carry one.

### What it binds

| Token            | Bound to                                                 |
| ---------------- | -------------------------------------------------------- |
| `LoggerSettings` | The `LoggerConfig` you passed, so a factory can read it  |
| `ContextStore`   | arkv's store                                             |
| `RequestContext` | The same `ContextStore`                                  |
| `BackingLogger`  | The `@arkv/logger` instance, typed as the implementation |
| `Logger`         | The same instance, typed as core's contract              |

`BackingLogger` reaches the three things the contract omits: `child(bindings)`,
`flush()` and `close()`. Core's `Logger` covers the six levels and nothing else,
so an app wanting a child logger asks for the implementation by name instead of
every app carrying a wider contract.

### Reading the level off config

`forRootAsync` exists for the one thing `forRoot` cannot express, since the
function it takes receives no arguments: **injecting**.

```ts
LoggerModule.forRootAsync(
  {
    useFactory: (config: AppConfigService) => {
      const log = config.get('log');
      return {
        name: config.get('appName'),
        level: log.level,
        ...(log.file === undefined
          ? {}
          : { transports: fileAndConsole(log.file) }),
      };
    },
    inject: [AppConfigService] as const,
  },
  { captureGlobalErrors: true },
);
```

See [Configuration](./12-configuration.md) for why the parameter is
`AppConfigService` and not `ConfigService<AppConfig>`.

### Transports

Supplying `transports` **replaces** the console sink, so keeping stdout means
naming it:

```ts
import {
  ConsoleTransport,
  FileTransport,
  type Transport,
} from '@dunx/infra/logger';

const fileAndConsole = (path: string): Transport[] => [
  new ConsoleTransport(),
  new FileTransport({
    path,
    interval: 'daily',
    maxFiles: 7,
    bufferBytes: 16 * 1024,
  }),
];
```

`FileTransport` buffers, which is safe here because `LoggerModule` registers a
lifecycle provider that drains it from `onShutdown`. That hook runs late:
`App.shutdown` walks instances in reverse resolution order and the logger resolves
before anything that depends on it, so services can still log while they close.

It drains with `closeAsync`, and the await matters for anything reached over a
network. A file is written synchronously and either form finishes it; a collector
cannot answer synchronously at all, so a plain `close()` discards whatever it was
holding and every deploy loses its last batch.

### Shipping somewhere other than a file

`HttpTransport` covers the collectors that differ only in the shape of the body:

```ts
import { HttpTransport, SamplingTransport } from '@dunx/infra/logger';

new HttpTransport({
  url: 'https://logs.example.com/ingest',
  headers: { authorization: `Bearer ${token}` },
  batchSize: 200,
  flushIntervalMs: 2000,
});
```

`encode` is the seam: Datadog wants a JSON array, Splunk HEC concatenated objects,
Loki streams and values. `SyslogTransport` speaks RFC 5424 over UDP or TCP, and
anything else that batches is a subclass of `BatchTransport`, which owns the
bounded queue, the retry and the drop accounting.

`SamplingTransport` wraps another transport to thin what reaches it. Warnings and
worse are never sampled, and every discard is announced in the stream rather than
being silent.

`logger.stats()` on the `BackingLogger` token reports what each transport is
holding and what it has dropped - the numbers an alert on "we are losing logs"
reads.

### Output formats

`format` on any transport takes one of four:

| Formatter      | Emits                                            |
| -------------- | ------------------------------------------------ |
| `jsonFormat`   | `{"level":"info","message":"order placed",…}`    |
| `prettyFormat` | the same JSON, ANSI-coloured for a terminal      |
| `textFormat`   | `09:00:15.123 INFO  order placed  requestId=r-1` |
| `logfmtFormat` | `level=info msg="order placed" order.id=ord_1`   |

`examples/full` reads `LOG_FORMAT` and wires whichever you name. A file always
takes a machine format even when the console does not, since nothing reads a log
file with its eyes first.

### `captureGlobalErrors`

```ts
LoggerModule.forRoot({ name: 'my-api' }, { captureGlobalErrors: true });
```

Installs `uncaughtException` and `unhandledRejection` handlers that log through
this logger and flush before the process goes away. `true` takes the defaults:
fatal for an uncaught exception, then `process.exit(1)`. Pass an options object to
tune it. Worth having in a service meant to stay up.

## What is logged at boot

Two things, without being asked, and both because the alternative was silence.

**The served table, once, at `listen()`.** One `info` entry naming every route on its
final path and every gateway with the messages it claims:

```json
{
  "level": "info",
  "message": "Serving 32 route(s) and 1 gateway(s)",
  "routes": ["GET /api/users", "POST /api/users", "..."],
  "gateways": [
    { "path": "/ws", "gateway": "EventsGateway", "events": ["chatMessage"] }
  ]
}
```

This is the answer to "is my route registered"; a service that logs nothing at
boot cannot answer it from production. Nest emits a line per controller and a
line per route to say the same thing. One structured entry carries the same
content in the shape a collector wants, and it is what `WorkerFactory` already
does for the consuming side, with `Consuming N job(s) on M queue(s)`.

It is at `listen()` rather than `create()` because `setGlobalPrefix` runs in between,
and a table listing unprefixed paths would name routes that do not exist.

```ts
HttpFactory.create(AppModule, { bootLogging: false }); // off
```

Separate from `requestLogging` rather than sharing its switch: one is per request and
one is per process, so silencing the noisy one is not a reason to lose the quiet one.
`@dunx/testing` defaults it off, for the same reason it defaults request logging off:
a suite that boots a server per file does not want a route table per file.

**Scope warnings, at `warn`, from `AppFactory.create`.** A module that declares
what an import already exports to it, or imports one token from two modules that
disagree, is legal and warned.

They used to sit on `app.warnings` and be logged by nobody, on the reasoning that
core had no logger. It has one now: `Logger` is always bound, and the reference
app never read the property, so a shadowed binding would have been silent in the
app most likely to hit one. The list is still public for an app that would
rather fail boot on it.

## Request logging

`@dunx/http` installs `RequestLoggingMiddleware` **by default**, outermost in the
chain, ahead of anything `middleware` declares. So a request rejected by a guard
is still logged with the status it got.

```ts
HttpFactory.create(AppModule); // on, defaults
HttpFactory.create(AppModule, { requestLogging: false }); // off
HttpFactory.create(AppModule, {
  requestLogging: { ignore: ['/health'], requestBody: true },
});
```

### One entry per request

The entry carries the request and its response together:

```json
{
  "level": "info",
  "timestamp": "...",
  "pid": 4711,
  "message": "POST /notes 201",
  "requestId": "7b1f...",
  "method": "POST",
  "event": "/notes",
  "flow": "http",
  "context": "NotesController.create",
  "request": { "userAgent": "curl/8.5.0" },
  "statusCode": 201,
  "elapsedMs": 4
}
```

dunx writes both halves from one middleware, because middleware wraps `next()`
and both halves are the same closure. A framework whose middleware cannot see
the response needs a middleware for the inbound half and an interceptor for the
outbound one instead: different classes, and the interceptor cannot see what
the middleware saw. There is no pair to correlate by `requestId` just to find
out how a call ended.

- A **4xx** is the same line at `warn`.
- A **5xx** is the same line at `error`.
- An error is logged and **rethrown**, so the error mapper still owns the status
  and the response shape.

An unmatched path is logged too. `Bun.serve({ routes })` answers a miss itself, so
`listen()` installs one `fetch` fallback that puts the global middleware in front
of a `{"error":"NOT_FOUND","status":404}`. That is not a JavaScript router: Bun
still does all the matching, and the fallback only runs once it has matched
nothing.

**Every global middleware runs on a miss, guards included.** A miss matched no
route, so it carries no route metadata, and a guard reading none of it refuses: an
app with a global `SessionGuard` answers an anonymous request for a nonexistent
path with that guard's status rather than a 404. There is no `@Public()` to put
on a path that does not exist.

The alternative leaks: if a miss answers 404 while every real path answers 401,
the difference enumerates your surface. For the conventional 404:

```ts
await HttpFactory.create(AppModule, { notFound: 'public' });
```

The miss then reports itself as `@Public()`, so a guard honouring that flag
passes it through. Either way it is logged and gets a request id, so the fallback
runs the middleware for both.

A guard can decide for itself under either setting. `UNMATCHED` is set on a miss
and no real route ever sets it:

```ts
import { PUBLIC, UNMATCHED } from '@dunx/http';

if (ctx.get(PUBLIC) === true && ctx.get(UNMATCHED) !== true) return next();
```

Everything the handler logs in between carries `requestId`, `method`, `event` and
`context` without being passed anything, because the whole call runs inside
`runWithContext`.

### `x-request-id`

An inbound `x-request-id` header is honoured, so a trace survives across
services, **but only if it is a UUID.**

It is a caller-supplied string that ends up in every line the request writes, so
`curl -H 'x-request-id: MY-OWN-ID'` is not echoed. A newline, a megabyte, or an
id collided with somebody else's trace is dropped and a fresh
`crypto.randomUUID()` used instead. Nothing tells the caller.

Any UUID version is accepted; the check reads the shape rather than the version bits.

It is set on the response of every request the middleware handles - which is every
request except an `ignore`d one, and one of those too if `correlateIgnored` is on.
See the option below. `requestIdHeader: false` stops it going out at all.

### Options

```ts
interface RequestLoggingOptions {
  maxBodyLength?: number; // default 2048; bodies past this log as a size, 0 omits
  requestBody?: boolean; // default false
  responseBody?: boolean; // default false
  ignore?: readonly string[]; // paths skipped entirely - see below
  ignorePrefix?: readonly string[]; // prefixes skipped, for a whole mount
  correlateIgnored?: boolean; // default false; keep the id on an ignored path
  correlate?: boolean; // default true; false drops the async scope - see below
  requestIdHeader?: boolean; // default true; false stops `x-request-id` going out
  trace?: boolean; // default false; adopt W3C Trace Context - see below
}
```

### `requestIdHeader`

The response header is the only part of request logging that leaves the process,
and it is about 500 ns of the 4.7 µs the path costs, which is 11%. It is the
largest single thing you can turn off without losing a field from a log line.

```ts
requestLogging: {
  requestIdHeader: false;
}
```

What you keep: the id is still minted, still on every line the middleware writes,
and still in the `AsyncLocalStorage` scope, so everything else the request logs
carries it. What you lose is the outward half, a caller quoting an id back at you,
and that includes failures: the error mapper stamps a fresh `Response` from what
the middleware recorded, and `false` stops it recording.

Turn it off on a service nothing correlates from the outside. Leave it on at an
edge.

**Both body options default to `false`**, and the request body is the field most
likely to contain a password. Turn them on in development.

What `requestBody` costs depends on whether the route declares a `body` schema, and
by a factor of fifteen:

| Setting                            | µs/req | vs the default |
| ---------------------------------- | -----: | -------------: |
| the default, both bodies off       |  17.25 |              - |
| `requestBody: true`, schema route  |  19.12 |       +1.87 µs |
| `responseBody: true`               |  19.80 |       +2.55 µs |
| both bodies, schema route          |  20.03 |       +2.78 µs |
| `requestBody: true`, **no** schema |  46.06 |      +28.81 µs |

A route that declares a body schema has already had the body buffered to validate
it, so logging it reads that text and copies nothing. A route that declares none
leaves the middleware to `req.clone()`, and cloning a request whose body is an
unread network stream is the whole difference.

### What `ignore` costs, and how to buy part of it back

`ignore` is for a health check polled every second, and **entirely** is literal.
The middleware slices the pathname - it has to, to check the list - and then
returns `next()` without touching anything else, so an ignored path has:

- no entry;
- no `x-request-id` on the response;
- no `AsyncLocalStorage` scope, so anything the handler logs is uncorrelated: no
  `requestId`, no `event`, no `context`.

Skipping all three is what makes it free. "Do not log the health check, but do
keep its request id" is `correlateIgnored`:

```ts
HttpFactory.create(AppModule, {
  requestLogging: { ignore: ['/health'], correlateIgnored: true },
});
```

The path still writes no entry of its own. It gets an id on the response, inbound
if it was a UUID and minted otherwise, and everything the handler logs carries it.

It is off by default because it costs something: the path pays for reading the
header, `crypto.randomUUID()`, the `runWithContext` scope and one `Headers.set`.
That is **~2.5 µs** of the 4.78 the full default path costs in the table below.
It never pays for building and serialising the entry, the expensive half.

### Turning the async scope off with `correlate: false`

The `runWithContext` scope used to be the most expensive thing request logging did
that was not the entry itself, at +0.91 µs on Bun 1.3.14. **Bun 1.4 made it too
cheap to measure:** +0.24 µs as a step, and turning it off moves the whole default
path from 4.78 µs to 4.48 µs. Both figures are inside the harness's ±0.5 µs
resolution, so the honest reading is that this option now buys nothing measurable.

```ts
HttpFactory.create(AppModule, { requestLogging: { correlate: false } });
```

**The request entry is unchanged.** The same `requestId`, `method`, `event`, `flow`
and `context` fields are written onto it directly instead of being read back out of
the store, so the line a log pipeline sees is identical and the `x-request-id`
response header still goes out. What is lost is everything _else_ the request logs:
those lines carry no `requestId`, and `updateContext` in a handler has nothing to
update.

It is not the default because correlation is most of what a request id is for, and
on Bun 1.4 there is no throughput argument on the other side either.

The option stays for an app that already threads correlation through explicitly, and
for `ignore` with `correlateIgnored`, where an ignored path gets the response header
and no scope. Do not reach for it expecting a speedup; re-measure on your own Bun
first.

## What it costs

`GET /json`, AMD Ryzen 9 5950X, Bun 1.4.0, 64 connections:

| Subject                        | req/s (median) | p50 ms | vs `Bun.serve` |
| ------------------------------ | -------------: | -----: | -------------: |
| `Bun.serve` (raw)              |        124,234 |  0.484 |         100.0% |
| `@dunx/http`                   |        114,283 |  0.519 |          92.0% |
| `@dunx/http` + request logging |         73,675 |  0.807 |          59.3% |

Structured logging of every request costs about 40% of peak throughput. That is not
a dunx tax; it is the cost of the work itself, and the breakdown says where it goes.
Each row below is the same app on the same route with one more piece of the
default path switched on. Read anything under about **±0.5 µs** as unresolvable:

| Step                                            | µs/req | this step adds |
| ----------------------------------------------- | -----: | -------------: |
| `requestLogging: false`                         |   7.98 |              - |
| one middleware that only calls `next()`         |   8.58 |       +0.60 µs |
| the pathname sliced out of `req.url`            |   9.31 |       +0.73 µs |
| `x-request-id` and `user-agent` read            |  10.28 |       +0.97 µs |
| `crypto.randomUUID()`                           |   9.98 |       -0.30 µs |
| `runWithContext` around the handler             |  10.22 |       +0.24 µs |
| `x-request-id` set on the response              |  10.46 |       +0.24 µs |
| the real middleware, `Logger` discards          |  10.85 |       +0.38 µs |
| `new Date().toISOString()`                      |  11.05 |       +0.21 µs |
| the entry and `JSON.stringify`, string dropped  |  12.83 |       +1.77 µs |
| **batched write instead - the shipped default** |  12.76 |       -2.40 µs |

The whole default path is **+4.78 µs**, and two steps account for most of it: the
**first touch of `req.headers`** and **building and serialising the entry**. Six of
the eleven steps land inside the ±0.5 µs resolution, and one of them is negative -
`crypto.randomUUID()` reads as -0.30 µs, which is the clearest available evidence
that a single step at this scale is at the harness's floor. Read the total, not the
row.

The `AsyncLocalStorage` scope is one of those six now. On Bun 1.3.14 it measured
+0.91 µs and was the third-largest item here; on 1.4 it is +0.24 µs, which the
harness cannot separate from zero. That changes what `correlate: false` is worth -
see below.

The write, isolated:

| Write                                    | µs/req |
| ---------------------------------------- | -----: |
| batched, `/dev/null`                     |  12.76 |
| one `console.log` per entry, `/dev/null` |  15.16 |
| batched, into a pipe nobody reads        |  12.98 |
| one per entry, into a pipe nobody reads  |  17.17 |

**Batching is now the largest single saving on the path**, worth 2.40 µs against a
`console.log` per entry and 4.19 µs when the consumer is slow, against a 4.78 µs
total. A `write(2)` per entry would cost more than everything else combined.

Batching also makes a slow consumer far less able to stall the server, which is
the last row's problem.

Two micro-optimisations in `ConsoleLogger` fall out of the same measurements.

`new Date().toISOString()` measured about 170 ns, and the millisecond has usually
not moved since the last entry, so one `Date.now()` guards a memoised stamp.

`logger.info('GET /json 200', fields)` is the shape every framework call takes,
so it is built directly instead of going through the general merge path, which
would cost two array allocations, a third object and an `Object.assign`.

Nothing in `RequestLoggingMiddleware` is `async`. Reading the request or the
response body are the only steps that can wait, both are off by default, and both
are adopted with `.then` rather than awaited. An `async` scope callback alone cost
**0.44 µs/request** against a synchronous one on raw `Bun.serve`.

## Related

- [Configuration](./12-configuration.md) for `AppConfigService` and `forRootAsync`
- [Authentication](./17-authentication.md), which writes `userId` into
  `RequestContext` so every line after sign-in is correlated
- [Providers](./03-providers.md) for how the default bindings are layered
