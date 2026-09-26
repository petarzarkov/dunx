# Tracing

Import `OtelModule` and every request served, call made, query run and message
handled opens an OpenTelemetry span. Without it, dunx starts no span and never
loads `@opentelemetry/api`.

## Turning it on

```sh
bun add @opentelemetry/api @opentelemetry/sdk-trace-node @opentelemetry/exporter-trace-otlp-http
```

Register a provider before `create`, then import the module:

```ts
// src/main.ts
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import {
  BatchSpanProcessor,
  NodeTracerProvider,
} from '@opentelemetry/sdk-trace-node';

new NodeTracerProvider({
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
}).register();

const app = await HttpFactory.create(AppModule);
```

```ts
import { Module } from '@dunx/core';
import { OtelModule } from '@dunx/core/otel';

@Module({ imports: [OtelModule, UsersModule] })
export class AppModule {}
```

| Piece                  | Owner                                                                         |
| ---------------------- | ----------------------------------------------------------------------------- |
| `@opentelemetry/api`   | An optional peer of `@dunx/core`, `^1.4.0`. Install it; dunx never bundles it |
| SDK, sampler, exporter | Your app. dunx configures none of them                                        |
| `Tracer`               | Core's third always-bound contract, after `Logger` and `RequestContext`       |
| `OtelModule`           | A decorated class that binds `Tracer` to `OtelTracer` for the whole graph     |

Keep exactly one copy of `@opentelemetry/api` installed. If a provider is
registered through one copy and spans are started through another, newer copy,
those spans are dropped without an error. Check with `bun why @opentelemetry/api`.

`@dunx/core/otel` is its own subpath. The root entry never imports the API, so an
app without it installed boots unchanged, compiled binaries included.

## What is traced

| Seam                        | Kind       | Name                                          | Attributes                                                                                                                    |
| --------------------------- | ---------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `@dunx/http` request        | `server`   | `GET /users/:id` (route template)             | `http.request.method`, `url.path`, `http.route`, `http.response.status_code`                                                  |
| Unmatched request (404)     | `server`   | `GET` (method alone)                          | `http.request.method`, `url.path`, `http.response.status_code`                                                                |
| `HttpService` call          | `client`   | `GET` (method alone), one per retry attempt   | `http.request.method`, `url.full`, `server.address`, `server.port`, `http.response.status_code`                               |
| `@dunx/infra/db` statement  | `client`   | `SELECT users`, else `SELECT`, else `sqlite`  | `db.system.name`, `db.query.text`, `db.operation.name`, `db.collection.name`, `db.namespace`, `server.address`, `server.port` |
| `@dunx/infra/redis` command | `client`   | `GET` (the verb)                              | `db.operation.name`, `server.address`, `server.port`                                                                          |
| Job publish                 | `producer` | `publish emails`                              | `messaging.system: bullmq`, `messaging.destination.name`, `messaging.message.id`, `bullmq.job.name`                           |
| Job handler                 | `consumer` | `process emails`                              | the same, with `messaging.operation.type: process`                                                                            |
| AMQP publish                | `producer` | `publish orders` (exchange, else routing key) | `messaging.system: rabbitmq`, `messaging.destination.name`, `messaging.rabbitmq.destination.routing_key`                      |
| AMQP handler                | `consumer` | `process orders.created` (queue)              | `messaging.system: rabbitmq`, `messaging.destination.name`, `messaging.message.id`                                            |

Keys are the OpenTelemetry semantic conventions, as plain strings; dunx has no
semconv dependency.

Status follows the conventions:

- A server span is `ERROR` on a 5xx or a thrown non-`HttpError`. A 4xx leaves it
  unset.
- A client span is `ERROR` when the call fails, including a non-2xx response.
- A failed query, command, publish or handler is `ERROR`. An `Error` adds an
  `exception` event.

A db span names the table only when the statement names exactly one: a `select`
with a join or a subquery, or a CTE, falls back to the operation. `bun:sqlite`
rejects a syntax error in `prepare`, and that still produces an `ERROR` span.

## Spans of your own

Inject `Tracer` wherever a unit of work is worth a span. It runs the callback
inside the span, ends it when the callback returns or its promise settles, and
records a throw:

```ts
import { Tracer } from '@dunx/core';

export class PaymentsService {
  constructor(
    private readonly tracer: Tracer,
    private readonly gateway: PaymentGateway,
  ) {}

  charge(order: Order): Promise<Receipt> {
    return this.tracer.span(
      'charge',
      { attributes: { 'order.id': order.id } }, // kind defaults to 'internal'
      (span) => {
        span.setAttribute('order.total', order.total);
        return this.gateway.charge(order);
      },
    );
  }
}
```

Without `OtelModule`, `Tracer` is the `NoopTracer`. The callback still runs, and
`span` is a shared object that records nothing.

With `OtelModule`, a span you start directly from `@opentelemetry/api` inside a
handler becomes a child of dunx's server span. This holds across `await`, timers,
`bun:sqlite` and `Bun.SQL`.

## Log lines join their span

When the SDK records a span, dunx writes its `traceId`, `spanId` and
`traceFlags` into `RequestContext`. Every line the request, job or message logs
then names the exported span, and so does `traceresponse`. A request's
`parentSpanId` stays the caller's span.

When nothing records (no SDK, or a sampler dropped the trace), dunx keeps minting
its own ids as it does without `OtelModule`. Logs keep a `traceId` either way.
The fields are described under [W3C Trace Context](./13-logging.md#w3c-trace-context).

## Propagation

| Direction              | Carrier                                    | Behaviour                                                                                     |
| ---------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------- |
| Inbound HTTP           | `traceparent`, `tracestate`                | Becomes the server span's remote parent. A malformed header starts a new trace                |
| Outbound `HttpService` | `traceparent`, `tracestate`                | Carries the client span's id, so the callee is its child. `tracestate` is forwarded unchanged |
| bullmq job             | `job.opts.telemetry.metadata`              | The producer span's `traceparent`; the consumer span's parent. `job.data` is never touched    |
| AMQP message           | `traceparent`, `tracestate` message header | The producer span's id; the consumer span's parent                                            |

A carrier the caller set is left alone, so forwarding a message or setting
`telemetry.omitContext` on a job passes through as written.

### Queues

dunx stores the trace context on a job in the same JSON format `bullmq-otel`
uses. So a job sent between a dunx app and an app using bullmq's own telemetry
keeps its parent span. dunx does not set bullmq's `telemetry` option.

A handler with `isolation: 'process'` runs in a separate process, which reads the
trace context from `job.opts`. That process has its own global tracer provider.
So the processor file must register an OpenTelemetry SDK, and its module must
import `OtelModule`:

```ts
// src/jobs.processor.ts
import './tracing.js'; // registers the NodeTracerProvider
import { JobProcessor } from '@dunx/infra/queue';
import { JobsProcessorModule } from './jobs.processor.module.js'; // imports OtelModule

export default new JobProcessor(JobsProcessorModule).handle;
```

`JobProcessorOptions.trace` is the `job.log()` switch from [Queues](./19-queues.md),
unrelated to spans.

### AMQP

`AmqpPublisher.publish` already stamps the scope's trace into the headers; with
`OtelModule` the stamped id is the producer span's. See
[Traces cross the broker](./20-message-brokers.md#traces-cross-the-broker).

## Request logging options

The server span opens inside the request-logging middleware, wherever a trace is
adopted:

| Setting                                | Server span                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------- |
| default                                | Yes                                                                         |
| `ignore` or `ignorePrefix` match       | No                                                                          |
| `ignore` with `correlateIgnored: true` | Yes                                                                         |
| `correlate: false`                     | Yes. The request entry carries its ids; other lines the request logs do not |
| `trace: false`                         | No                                                                          |
| `requestLogging: false`                | No                                                                          |

Outbound calls, queries and commands made where no server span is open still get
their own spans, each starting a trace.

## What is not recorded

| Seam   | Left out                                                                                            |
| ------ | --------------------------------------------------------------------------------------------------- |
| db     | Bound parameters are never read. `db.query.text` is the statement with its literals replaced by `?` |
| redis  | Keys and values. The span carries the verb and the server                                           |
| server | The query string: `url.path` is the pathname                                                        |
| jobs   | The payload                                                                                         |

`HttpService`'s `url.full` is the URL as sent, query string included. Keep
secrets out of outbound query strings, or drop the attribute in a span processor.

## What it costs

A recording SDK adds 2.0 to 3.2 us per request over an unrecorded span, depending
on the exporter. Under the default `NoopTracer` every seam skips span work
entirely. The measurements are in [the constraints record](../architecture/constraints.md#opentelemetry-spans-on-bun-142).

## Testing spans

`bun test` runs every file in one process, and the API's global provider
registers once. Register one in-memory exporter in a shared file and filter by
trace:

```ts
// test/otel.ts
import {
  InMemorySpanExporter,
  NodeTracerProvider,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';

export const exporter = new InMemorySpanExporter();

new NodeTracerProvider({
  spanProcessors: [new SimpleSpanProcessor(exporter)],
}).register();
```

```ts
import { expect, it } from 'bun:test';
import { OtelModule } from '@dunx/core/otel';
import { createTestServer } from '@dunx/testing';
import { SpanKind } from '@opentelemetry/api';
import { exporter } from './otel.js';

it('opens a server span named by route', async () => {
  const traceId = crypto.getRandomValues(new Uint8Array(16)).toHex();
  const server = await createTestServer({
    modules: [OtelModule, UsersModule],
    requestLogging: true, // defaulted to false here, and the span lives in it
  });

  await server.json('users/42', {
    headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
  });
  await server.close();

  const [span] = exporter
    .getFinishedSpans()
    .filter((each) => each.spanContext().traceId === traceId);
  expect(span?.name).toBe('GET /users/:id');
  expect(span?.kind).toBe(SpanKind.SERVER);
});
```

## Related

- [Logging](./13-logging.md) for the trace fields on every line
- [Metrics](./24-metrics.md) for `slowestTraceId`, which names a request's trace
- [Queues](./19-queues.md) and [RabbitMQ over AMQP](./20-message-brokers.md)
- `examples/full`, which imports `OtelModule`
