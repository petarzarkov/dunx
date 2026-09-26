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
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "traceFlags": "01",
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

A `console.log` per entry is a `write(2)` per entry, and that write was the
largest single component of request logging, more than the `JSON.stringify` that
produced the line. One concatenated write per event-loop turn removes most of it;
the figures are in [the cost of request logging](../architecture/cost-of-logging.md).

The cost: **a line still in the buffer is lost if the process dies without
unwinding**, for example on a `SIGKILL`, an OOM kill or a segfault.

Three things limit the loss:

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

The second contract in core. It holds per-request fields such as `traceId`, so
any service can read them without the value being passed down:

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
`traceId`, `spanId`, `parentSpanId`, `traceFlags`, `userId`, `method`, `event`,
`context`, `flow` - and permits anything else. The first four are OpenTelemetry's
log data model fields, so a collector joins these lines to spans emitted by
anything else that speaks the standard.

`AsyncRequestContext` is the default implementation, over `AsyncLocalStorage`,
with one departure from the built-in: **nested scopes merge.**

`AsyncLocalStorage.run` replaces the store outright, dropping the `traceId` an
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
        // every log line in here carries flow, event, and the caller's traceId
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

There is no adapter class. `@arkv/logger`'s `Logger` has `logLevel` and all six
levels with the same overloads, so it is bound to core's `Logger` directly.
arkv's `ContextStore` matches `RequestContext` the same way, and `LoggerModule`
binds it to that token too.

The context binding is required. Without it, `@dunx/http`'s request logging
would write `traceId` into core's default store, `@arkv/logger` would read its
own store, and no entry would carry a `traceId`.

### What it binds

| Token            | Bound to                                                 |
| ---------------- | -------------------------------------------------------- |
| `LoggerSettings` | The `LoggerConfig` you passed, so a factory can read it  |
| `ContextStore`   | arkv's store                                             |
| `RequestContext` | The same `ContextStore`                                  |
| `BackingLogger`  | The `@arkv/logger` instance, typed as the implementation |
| `Logger`         | The same instance, typed as core's contract              |

Core's `Logger` has only the six levels. Inject `BackingLogger` when you need
`child(bindings)`, `flush()` or `close()`.

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

`FileTransport` buffers. `LoggerModule` drains it in `onShutdown`, and that runs
after the services that depend on the logger have shut down, so they can still
log while they close.

The drain uses `closeAsync` and awaits it. That matters for network transports:
a plain `close()` cannot wait for a collector to answer, so it would drop the
last batch on every deploy. A file is written synchronously, so either call
finishes it.

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

Set `encode` to match the collector's body format: a JSON array for Datadog,
concatenated objects for Splunk HEC, streams and values for Loki.
`SyslogTransport` sends RFC 5424 over UDP or TCP. For any other batching sink,
subclass `BatchTransport`; it handles the bounded queue, retries and counting
dropped entries.

`SamplingTransport` wraps another transport to thin what reaches it. Warnings and
worse are never sampled, and every discard is announced in the stream rather than
being silent.

`logger.stats()` on the `BackingLogger` token reports what each transport is
holding and what it has dropped - the numbers an alert on "we are losing logs"
reads.

### Output formats

`format` on any transport takes one of four:

| Formatter      | Emits                                               |
| -------------- | --------------------------------------------------- |
| `jsonFormat`   | `{"level":"info","message":"order placed",…}`       |
| `prettyFormat` | the same JSON, ANSI-coloured for a terminal         |
| `textFormat`   | `09:00:15.123 INFO  order placed  traceId=4bf92f35` |
| `logfmtFormat` | `level=info msg="order placed" order.id=ord_1`      |

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

Use it to check whether a route is registered in production. Nest logs a line
per controller and per route; dunx logs one structured entry. `WorkerFactory`
logs the same kind of entry for queues: `Consuming N job(s) on M queue(s)`.

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

The same warnings are also on `app.warnings`, so an app can read them and fail
boot if it wants to.

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
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "spanId": "00f067aa0ba902b7",
  "traceFlags": "01",
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
the middleware saw. There is no pair to correlate by `traceId` just to find
out how a call ended.

- A **4xx** is the same line at `warn`.
- A **5xx** is the same line at `error`.
- An error is logged and **rethrown**, so the error mapper still owns the status
  and the response shape.

A request to an unmatched path is also logged and traced. It still runs every
global middleware and guard, whether `notFound` is `'public'` or `'guarded'`. See
[the `fetch` fallback](./05-controllers.md#the-fetch-fallback).

The `warn` for an unmatched path, a scanner's `/wp-admin` or `/.env`, is
written at most once a second per app. The next line written carries
`suppressed`, the misses dropped since the last one. A 4xx on a matched route
or on a path a middleware claims keeps a line of its own, and metrics count
every request either way.

A guard can decide for itself under either setting. `UNMATCHED` is set on a miss
and no real route ever sets it:

```ts
import { PUBLIC, UNMATCHED } from '@dunx/http';

if (ctx.get(PUBLIC) === true && ctx.get(UNMATCHED) !== true) return next();
```

Everything the handler logs in between carries `traceId`, `method`, `event` and
`context` without being passed anything, because the whole call runs inside
`runWithContext`.

### W3C Trace Context

Every request adopts a trace. An inbound `traceparent` is continued with a span of
this server's own; without one, a fresh trace id and span id are minted. Four
fields reach the async scope and therefore every line the request writes:
`traceId`, `spanId`, `parentSpanId` when a caller sent one, and `traceFlags`.

The response carries `traceresponse`, naming the span that answered. That header
is a W3C Distributed Tracing Working Group proposal rather than a ratified
standard: `traceparent` and `tracestate` are the Recommendation, and both are
request headers. Treat a caller reading it as a bonus.

```console
$ curl -i -H 'traceparent: 00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' localhost:3000/notes
traceresponse: 00-4bf92f3577b34da6a3ce929d0e0e4736-7a9d1a31080e694d-01
```

A malformed `traceparent` is **discarded rather than repaired**, which is what the
standard requires. The request starts a trace of its own rather than joining one
that may not exist, and nothing tells the caller.

An all-zero trace id, an all-zero span id, the reserved version `ff` and a non-hex
field are each rejected. A version this code does not know keeps its first four
fields, so a future format still propagates.

The inbound sampling flag is kept as sent, so a trace an upstream sampler
declined stays unsampled. `tracestate` is passed through unchanged when
`traceparent` is valid, and dropped when it is not.

`@dunx/http/client` sends the current trace upstream as `traceparent`, so one
trace spans both services. It reads `traceFlags` from the same store.

This needs no exporter, sampler or dependency: dunx reads one header and writes
two.

With `OtelModule` imported and an SDK recording, these ids are the exported
span's own. See [Tracing](./31-tracing.md).

`trace: false` removes all of it, at which point a request carries no correlation
id at all.

```ts
HttpFactory.create(AppModule, { requestLogging: { trace: false } });
```

### Options

```ts
interface RequestLoggingOptions {
  maxBodyLength?: number; // default 2048; bodies past this log as a size, 0 omits
  requestBody?: boolean; // default false
  responseBody?: boolean; // default false
  ignore?: readonly string[]; // paths skipped entirely - see below
  ignorePrefix?: readonly string[]; // prefixes skipped, for a whole mount
  correlateIgnored?: boolean; // default false; keep the trace on an ignored path
  correlate?: boolean; // default true; false drops the async scope - see below
  trace?: boolean; // default true; W3C Trace Context - see above
  traceResponse?: boolean; // default true; false stops `traceresponse` going out
}
```

### `traceResponse`

The response header is the only part of request logging that leaves the process,
and about a tenth of what the default path costs. It is the largest single thing
you can turn off without losing a field from a log line.

```ts
requestLogging: {
  traceResponse: false;
}
```

The request still gets a trace. It is still on every line the middleware writes,
in the `AsyncLocalStorage` scope, and on the metrics exemplar.

Only the `traceresponse` header goes, on every response including errors, so a
caller can no longer tell you which span answered it.

Turn it off on a service nothing correlates from the outside. Leave it on at an
edge.

**Both body options default to `false`**, and the request body is the field most
likely to contain a password. Turn them on in development.

What `requestBody` costs depends on whether the route declares a `body` schema:
about 2 µs per request with one, about 29 µs without.

A route that declares a body schema has already had the body buffered to validate
it, so logging it reads that text and copies nothing. A route that declares none
leaves the middleware to `req.clone()`, and cloning a request whose body is an
unread network stream is the whole difference.

### What `ignore` costs, and how to buy part of it back

`ignore` is for a health check polled every second, and **entirely** is literal.
The middleware slices the pathname - it has to, to check the list - and then
returns `next()` without touching anything else, so an ignored path has:

- no entry;
- no trace, and no `traceresponse` on the response;
- no `AsyncLocalStorage` scope, so anything the handler logs is uncorrelated: no
  `traceId`, no `event`, no `context`.

Skipping all three is what makes it free. "Do not log the health check, but do
keep its trace" is `correlateIgnored`:

```ts
HttpFactory.create(AppModule, {
  requestLogging: { ignore: ['/health'], correlateIgnored: true },
});
```

The ignored path still writes no log entry. It does get a trace: an inbound
trace is continued or a new one is started, the response carries
`traceresponse`, and every line the handler logs includes the trace ids.

It is off by default because it costs about half as much as full request logging.
The work is reading the header, creating ids, the `runWithContext` scope and one
`Headers.set`. The other half, building and writing the entry, is still skipped.

### Turning the async scope off with `correlate: false`

The `runWithContext` scope used to be the most expensive thing request logging did
that was not the entry itself. **Bun 1.4 made it too cheap to measure**, so this
option now buys nothing measurable.

```ts
HttpFactory.create(AppModule, { requestLogging: { correlate: false } });
```

**The request entry is unchanged.** The same `traceId`, `method`, `event`, `flow`
and `context` fields are written onto it directly instead of being read back out of
the store, so the line a log pipeline sees is identical and the `traceresponse`
header still goes out. What is lost is everything _else_ the request logs: those
lines carry no `traceId`, and `updateContext` in a handler has nothing to update.

It defaults to `true` because correlating the handler's own lines is most of
what a trace is for, and on Bun 1.4 turning it off is not faster.

Use it if your app already passes correlation fields explicitly. With `ignore`
and `correlateIgnored`, it gives an ignored path the response header and no
scope. Do not expect a speedup; measure on your own Bun version first.

## What it costs

`GET /json`, AMD Ryzen 9 5950X, Bun 1.4.0, 64 connections:

| Subject                        | req/s (median) | p50 ms | vs `Bun.serve` |
| ------------------------------ | -------------: | -----: | -------------: |
| `Bun.serve` (raw)              |        124,234 |  0.484 |         100.0% |
| `@dunx/http`                   |        114,283 |  0.519 |          92.0% |
| `@dunx/http` + request logging |         73,675 |  0.807 |          59.3% |

Structured logging of every request costs about 40% of peak throughput, and that
is the work itself rather than framework overhead. About 4.8 µs per request, most
of it in the first touch of `req.headers` and in building and serialising the
entry. Batching the write is the largest single saving.

The step-by-step
breakdown, the body-option figures and the rejected alternatives are in
[the cost of request logging](../architecture/cost-of-logging.md).

## Related

- [Tracing](./31-tracing.md) for OpenTelemetry spans that share these ids
- [Configuration](./12-configuration.md) for `AppConfigService` and `forRootAsync`
- [Authentication](./17-authentication.md), which writes `userId` into
  `RequestContext` so every line after sign-in is correlated
- [Providers](./03-providers.md) for how the default bindings are layered
