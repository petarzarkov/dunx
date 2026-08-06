# Logging

dunx logs every HTTP request out of the box, in an app that imported no logging
module at all, and it does that without `@dunx/core` taking a single dependency.
This page explains how, what it costs, and what you get by swapping the default
out.

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

An abstract class rather than an `interface`, because `@dunx/transform` records
constructor parameter **types**, and an interface has no runtime value to record.
An interface here would be a boot error at every injection site. That is the same
trick `RequestContext`, `Storage`, `DbOptions` and `Auth` all use.

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

`LogLevel` is a frozen object plus an indexed-access union, not a TypeScript
`enum`. One exported name serves as both the value and the type:

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

**What it deliberately does not do:** sanitize, mask, rotate, colour, or handle a
cyclic object. `JSON.stringify` is used directly, because a cycle in a log entry
would be the logger's fault and the replacement that handles cycles is one import
away. That missing list is exactly what makes swapping in `@dunx/infra/logger`
worth the dependency.

### Buffering, and the durability trade

`ConsoleLogger` **batches `info` and below into one write per event-loop turn.**

This landed because a `console.log` per entry is a `write(2)` per entry, and
measured on `bun run logging` in `tools/bench`, that was the largest single
component of request logging: **1.84 µs**, more than the `JSON.stringify` that
produced the line. Concatenating into one string and writing it once per
event-loop turn costs **0.27 µs**.

The trade is real and worth stating plainly: **a line still sitting in the buffer
is lost if the process dies without unwinding** - a `SIGKILL`, an OOM kill, a
segfault - which is exactly when the log matters most.

Three things bound it:

- **`warn`, `error` and `fatal` are never buffered.** They go out immediately and
  **flush everything queued ahead of them**, so the entries you go looking for
  after a crash are the ones that were never held back.
- The window is **one event-loop turn**, not a timer interval.
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

`AsyncRequestContext` is the default implementation, over `AsyncLocalStorage`. One
detail is not what the built-in does on its own: **nested scopes merge.**
`AsyncLocalStorage.run` replaces the store outright, which would drop the
`requestId` an outer scope established. `runWithContext` merges instead, into a
fresh object, so an `updateContext` inside a nested scope does not leak back out.
Pass `{ inherit: false }` to get the replacing behaviour deliberately.

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

`@dunx/infra/logger` binds core's contract to `@arkv/logger`, a first-party
package the repo owner maintains. dunx supplies the contract and the wiring and
**restates none of the configuration**.

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

`BackingLogger` is how you reach the three things the contract deliberately does
not carry: `child(bindings)`, `flush()` and `close()`. Core's `Logger` covers the
six levels and nothing else, on purpose, so an app that wants a child logger asks
for the implementation by name rather than every app getting a wider contract.

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

See [Configuration](./11-configuration.md) for why the parameter is
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
lifecycle provider that flushes and closes it from `onShutdown`. That hook runs
late: `App.shutdown` walks instances in reverse resolution order and the logger
resolves before anything that depends on it, so services can still log while they
close.

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

This is the answer to "is my route registered", and a service that logs nothing at
boot cannot answer it from production. Nest emits a line per controller and a line
per route to say the same thing; one structured entry is the same content in the
shape a collector wants, and it is what `WorkerFactory` already does for the
consuming side with `Consuming N job(s) on M queue(s)`.

It is at `listen()` rather than `create()` because `setGlobalPrefix` runs in between,
and a table listing unprefixed paths would name routes that do not exist.

```ts
HttpFactory.create(AppModule, { bootLogging: false }); // off
```

Separate from `requestLogging` rather than sharing its switch: one is per request and
one is per process, so silencing the noisy one is not a reason to lose the quiet one.
`@dunx/testing` defaults it off, for the same reason it defaults request logging off:
a suite that boots a server per file does not want a route table per file.

**Scope warnings, at `warn`, from `AppFactory.create`.** A module that declares what
an import already exports to it, or imports one token from two modules that disagree,
is legal and warned. They used to be surfaced on `app.warnings` and logged by nobody,
on the reasoning that core had no logger - it has one, `Logger` is always bound, and
the reasoning failed its first real test: the reference app never read the property,
so a shadowed binding would have been silent in the app most likely to hit one. The
list is still public for an app that would rather fail boot on it.

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

### One entry per request, not two

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

A framework whose middleware cannot see the response needs a middleware for the inbound half and an interceptor for the outbound
one, because they are different classes and the interceptor cannot see what the
middleware saw. dunx does not, because middleware wraps `next()` and both halves
are the same closure. There is no pair to correlate by `requestId` just to find out
how a call ended.

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
path with that guard's status, not a 404. There is no `@Public()` to put on a path
that does not exist.

That is the default because the alternative leaks: if a miss answers 404 while
every real path answers 401, the difference enumerates your surface. If you would
rather have the conventional 404:

```ts
await HttpFactory.create(AppModule, { notFound: 'public' });
```

The miss then reports itself as `@Public()`, so a guard honouring that flag passes
it through. Either way it is still logged and still gets a request id, which is the
reason the fallback runs the middleware at all.

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

An inbound `x-request-id` header is honoured, so a trace survives across services -
**but only if it is a UUID.** It is a caller-supplied string that ends up in every
line the request writes, so `curl -H 'x-request-id: MY-OWN-ID'` is not echoed: a
newline, a megabyte, or an id deliberately collided with somebody else's trace is
dropped and a fresh `crypto.randomUUID()` used instead. Nothing tells the caller,
because there is nothing a caller needs to do about it.

Any UUID version is accepted; the check is the shape, not the version bits.

It is set on the response of every request the middleware handles - which is every
request except an `ignore`d one, and one of those too if `correlateIgnored` is on.
See the option below.

### Options

```ts
interface RequestLoggingOptions {
  maxBodyLength?: number; // default 2048; bodies past this log as a size, 0 omits
  requestBody?: boolean; // default false
  responseBody?: boolean; // default false
  ignore?: readonly string[]; // paths skipped entirely - see below
  correlateIgnored?: boolean; // default false; keep the id on an ignored path
  correlate?: boolean; // default true; false drops the async scope - see below
}
```

**Both body options default to `false`, and that default is a performance
decision.** Reading a body means `req.clone().text()`: a second copy of every
payload, buffered and parsed, on the hot path. Measured on the `validate` scenario
in `tools/bench`, turning both on costs roughly **two thirds of the throughput**.
It is also the field most likely to contain a password. Turn them on in
development, where seeing the payload is the point.

### What `ignore` costs, and how to buy part of it back

`ignore` is for a health check polled every second, and **entirely** is literal.
The middleware slices the pathname - it has to, to check the list - and then
returns `next()` without touching anything else, so an ignored path has:

- no entry, which is the point;
- no `x-request-id` on the response;
- no `AsyncLocalStorage` scope, so anything the handler logs is uncorrelated - no
  `requestId`, no `event`, no `context`.

That is what makes it free. "Do not log the health check, but do keep its request
id" is `correlateIgnored`:

```ts
HttpFactory.create(AppModule, {
  requestLogging: { ignore: ['/health'], correlateIgnored: true },
});
```

The path still writes no entry of its own. It gets an id - inbound if it was a
UUID, minted otherwise - on the response, and everything the handler logs carries
it. It is off by default because it is not free: that path then pays for reading
the header, `crypto.randomUUID()`, the `runWithContext` scope and one
`Headers.set`, which is **~2.2 µs** of the ~5.4 the full default path costs in the
table below. What it never pays for is building and serialising the entry, which is
the expensive half.

### Turning the async scope off with `correlate: false`

The `runWithContext` scope is the single most expensive thing request logging does
that is not the entry itself - **+0.91 µs**, 17% of the 5.38 the whole default path
costs. An app whose handlers never log pays it for nothing.

```ts
HttpFactory.create(AppModule, { requestLogging: { correlate: false } });
```

**The request entry is unchanged.** The same `requestId`, `method`, `event`, `flow`
and `context` fields are written onto it directly instead of being read back out of
the store, so the line a log pipeline sees is identical and the `x-request-id`
response header still goes out. What is lost is everything _else_ the request logs:
those lines carry no `requestId`, and `updateContext` in a handler has nothing to
update.

It is not the default because correlation is most of what a request id is for.
Reach for it when handlers do not log, or when the app already threads correlation
through explicitly. With `ignore` and `correlateIgnored` it wins: an ignored path
then gets the response header and no scope.

## What it costs

This repo publishes its losses. From `tools/bench/README.md`, `GET /json`, AMD
Ryzen 9 5950X, Bun 1.3.14, 64 connections:

| Subject                        | req/s (median) | p50 ms | vs `Bun.serve` |
| ------------------------------ | -------------: | -----: | -------------: |
| `Bun.serve` (raw)              |        130,055 |  0.458 |         100.0% |
| `@dunx/http`                   |        123,306 |  0.492 |          94.8% |
| `@dunx/http` + request logging |         70,743 |  0.860 |          54.4% |

Structured logging of every request roughly halves peak throughput. That is not a
dunx tax; it is the cost of the work itself, and the breakdown says where it goes.
Each row below is the same app on the same route with one more piece of the
default path switched on. Read anything under about **±0.5 µs** as unresolvable:

| Step                                            | µs/req | this step adds |
| ----------------------------------------------- | -----: | -------------: |
| `requestLogging: false`                         |   8.67 |              - |
| one middleware that only calls `next()`         |   8.72 |       +0.05 µs |
| the pathname sliced out of `req.url`            |   9.45 |       +0.73 µs |
| `x-request-id` and `user-agent` read            |  10.74 |       +1.29 µs |
| `crypto.randomUUID()`                           |  10.78 |       +0.04 µs |
| `runWithContext` around the handler             |  11.69 |       +0.91 µs |
| `x-request-id` set on the response              |  11.65 |       -0.03 µs |
| the real middleware, `Logger` discards          |  12.45 |       +0.80 µs |
| `new Date().toISOString()`                      |  12.62 |       +0.17 µs |
| the entry and `JSON.stringify`, string dropped  |  14.67 |       +2.04 µs |
| **batched write instead - the shipped default** |  14.05 |       -0.61 µs |

Reading it: the middleware chain, `crypto.randomUUID()` and setting the response
header are each at or below what the harness can resolve. What costs is the
**first touch of `req.headers`**, the `AsyncLocalStorage` scope, and **building
and serialising the entry**.

The write, isolated:

| Write                                    | µs/req |
| ---------------------------------------- | -----: |
| batched, `/dev/null`                     |  14.05 |
| one `console.log` per entry, `/dev/null` |  15.91 |
| batched, into a pipe nobody reads        |  15.21 |
| one per entry, into a pipe nobody reads  |  18.59 |

Batching also makes a slow consumer far less able to stall the server, which is
the last row's problem.

Two micro-optimisations in `ConsoleLogger` fall out of the same measurements.
`new Date().toISOString()` measured about 170 ns and the millisecond has usually
not moved since the last entry, so one `Date.now()` guards a memoised stamp. And
`logger.info('GET /json 200', fields)` is the shape every framework call has, so
it is built directly rather than going through the general merge path, which
would cost two array allocations, a third object and an `Object.assign`.

Nothing in `RequestLoggingMiddleware` is `async`. Reading the request or the
response body are the only steps that can wait, both are off by default, and both
are adopted with `.then` rather than awaited. An `async` scope callback alone cost
**0.44 µs/request** against a synchronous one on raw `Bun.serve`.

## Related

- [Configuration](./11-configuration.md) for `AppConfigService` and `forRootAsync`
- [Authentication](./15-authentication.md), which writes `userId` into
  `RequestContext` so every line after sign-in is correlated
- [Providers](./03-providers.md) for how the default bindings are layered
