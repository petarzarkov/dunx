# RabbitMQ over AMQP

**RabbitMQ is the broker, and `rabbitmq-client` is the client.**
`@dunx/infra/amqp` contributes the same four things
[`@dunx/infra/queue`](./19-queues.md) does, over this client. It writes no AMQP
framing, no retry policy and no dead-letter helper.

```bash
bun add rabbitmq-client
```

An **optional peer dependency**, so an app using only `@dunx/infra/files`
installs nothing.

## When this rather than `@dunx/infra/queue`

A unit of work this process created for itself to do later is a job, and belongs
on the other backend. A message whose consumers this process does not know about
belongs here. An app can hold both, and `examples/full` does.

[Choosing a backend](./19-queues.md#choosing-a-backend), on
[bullmq over Redis](./19-queues.md), has the table.

## Handlers

`@AmqpHandler` marks a method the way `@JobHandler` does in
[bullmq over Redis](./19-queues.md#a-handler-is-a-method-with-a-decorator), and is
found by the same prototype scan: no class decorator, no registry, no queue
token.

```ts
import { Logger } from '@dunx/core';
import { AmqpHandler, type AmqpMessage } from '@dunx/infra/amqp';

export class Orders {
  constructor(
    private readonly ledger: Ledger,
    private readonly logger: Logger,
  ) {}

  @AmqpHandler({
    queue: 'orders.created',
    exchange: 'shop',
    routingKey: 'order.created',
  })
  async onCreated(message: AmqpMessage<{ id: string }>): Promise<void> {
    await this.ledger.record(message.body.id);
    this.logger.info(`recorded order ${message.body.id}`);
  }
}
```

Declare `Orders` in a module's `providers`; nothing else registers it.

Returning acknowledges the delivery. Throwing nacks it, with `requeue` deciding
whether the broker puts it back or sends it to the queue's dead-letter exchange.
Return a `ConsumerStatus` to say so outright:

`ConsumerStatus` comes from `rabbitmq-client` rather than from dunx, the way a
`Job` comes from bullmq:

```ts
import { ConsumerStatus } from 'rabbitmq-client';

@AmqpHandler({ queue: 'orders.created' })
async onCreated(message: AmqpMessage<{ id: string }>): Promise<ConsumerStatus> {
  if (await this.ledger.has(message.body.id)) return ConsumerStatus.DROP;
  await this.ledger.record(message.body.id);
  return ConsumerStatus.ACK;
}
```

`queue`, `exchange` and `routingKey` cover the common binding:

| Field          | Default            | Does                                                                                                       |
| -------------- | ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `queue`        | required           | Declared before the first delivery                                                                         |
| `exchange`     | none               | Declared and bound to `queue`. Absent, the queue is consumed as it is and a publisher addresses it by name |
| `routingKey`   | the queue name     | The binding key. Ignored without an `exchange`                                                             |
| `exchangeType` | `'topic'`          | Passed to the declare. `'direct'`, `'fanout'` and `'headers'` are the others AMQP defines                  |
| `consumer`     | the module default | Merged over `AmqpOptions.consumer`                                                                         |

An exchange declared this way is `durable: true`. A `@dunx/infra/amqp` binding
appends to whatever `consumer.exchanges` and `consumer.queueBindings` already
declare rather than replacing them, so one handler can hold both.

Anything else `rabbitmq-client` takes goes in `consumer`, forwarded verbatim:

```ts
@AmqpHandler({
  queue: 'orders.created',
  consumer: {
    concurrency: 4,
    qos: { prefetchCount: 8 },
    requeue: false,
    queueOptions: {
      durable: true,
      arguments: { 'x-dead-letter-exchange': 'shop.dlx' },
    },
  },
})
```

**One queue, one handler.** A second consumer on a queue is how AMQP spreads load
across processes, so two in one process makes the broker round-robin between them
and each sees roughly half the deliveries. Two handlers on one queue is a boot
error naming both; `consumer.concurrency` is the knob for throughput.

**`requeue` defaults to true, which loops on a message that can never succeed.** A
body the handler cannot parse throws on every redelivery. Validate the body and
return `ConsumerStatus.DROP` for one that is malformed, or set `requeue: false`
with an `x-dead-letter-exchange` on the queue so the broker parks it.

## Setup

```ts
import { Module } from '@dunx/core';
import { AmqpModule } from '@dunx/infra/amqp';
import { Orders } from './orders.js';

@Module({
  imports: [AmqpModule.forRoot({ url: process.env.RABBITMQ_URL })],
  providers: [Orders],
})
export class OrdersModule {}
```

The url defaults to `$RABBITMQ_URL`, then `$AMQP_URL`, then
`amqp://guest:guest@localhost:5672`. A url whose scheme is neither `amqp:` nor
`amqps:` fails at boot: `rabbitmq-client` retries a failed connection forever, so
a typo would otherwise show up as a publish that never settles.

A url naming neither user nor password gets `guest:guest` spliced in.
`rabbitmq-client` reads both out of the string unconditionally, so
`amqp://broker:5672` would otherwise authenticate as user `''` with a blank
password and RabbitMQ refuses it. A url carrying a username is left alone, blank
password and all.

Neither error prints the url. An AMQP url usually contains a password, and a url
that cannot be parsed cannot have its password masked.

`forRootAsync` reads the url off `ConfigService`. `ConfigModule` is global, so
the factory needs no `imports` to reach it:

```ts
AmqpModule.forRootAsync({
  useFactory: (config: AppConfigService) => ({ url: config.get('amqp').url }),
  inject: [AppConfigService],
});
```

The module binds and exports `AmqpOptions`, `AmqpConnection` and `AmqpPublisher`,
and opens no socket until the first publish. `AmqpRunner` is bound without being
exported, and is the piece that opens consumers under `consume`.

### Options

| Option             | Default                                                                           | Notes                                                                                   |
| ------------------ | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `url`              | `$RABBITMQ_URL`, `$AMQP_URL`, then `amqp://guest:guest@localhost:5672`            | Scheme checked when the module is configured                                            |
| `connectionName`   | `'dunx'`                                                                          | What this connection is called in the broker's management UI                            |
| `connection`       | `{}`                                                                              | Forwarded verbatim to `Connection`: `heartbeat`, `frameMax`, `retryLow`, `tls`, `hosts` |
| `consumer`         | `{ concurrency: 8, qos: { prefetchCount: 16 }, queueOptions: { durable: true } }` | The default every handler's own `consumer` merges over                                  |
| `publisher`        | `{ confirm: true }`                                                               | Forwarded verbatim to the one `Publisher` this app opens                                |
| `readyTimeoutMs`   | `5000`                                                                            | How long `start()` waits for each consumer to report itself set up                      |
| `drainTimeoutMs`   | `10000`                                                                           | How long shutdown waits for each consumer to drain                                      |
| `closeTimeoutMs`   | `5000`                                                                            | How long the publisher's channel and then the connection get to close                   |
| `publishTimeoutMs` | `10000`                                                                           | How long `publish()` waits for the broker's confirm. Must be positive                   |
| `handlerTimeoutMs` | none                                                                              | Reject a handler that runs longer. See below                                            |
| `consume`          | `false`                                                                           | `true`, or `'if-any'`. See below                                                        |

`prefetchCount` is twice `concurrency`, as `rabbitmq-client` recommends. A
handler's `consumer` merges into `qos` and `queueOptions` key by key, so
overriding one field keeps the module-wide defaults for the rest: a handler that
sets `queueOptions: { arguments: { ... } }` still gets `durable: true`.

`connection` and `consumer` cannot name `url`, `connectionName` or `queue`. Those
are `AmqpConnection`'s and the handler's, and the two passthrough types
(`ConnectionPassthrough`, `ConsumerPassthrough`) omit them.

## Publishing and consuming are separate decisions

`AmqpModule.forRoot()` binds the publish side. `consume: true` adds the consuming
side to the same container:

```ts
AmqpModule.forRoot({ url, consume: true });
```

Off by default, so a web process that imported the module to send a message does
not also start pulling work. On, the container owns the consumers: they start at
`onInit`, once every provider exists, and stop at `onShutdown`, before the
database connections the handlers use close.

`consume: 'if-any'` warns and stands down where `true` fails boot, for a
deployment whose broker wiring lands before its first `@AmqpHandler`.

A dedicated consumer process is the same module graph with no HTTP server:

```ts
const app = await AppFactory.create(WorkerModule);
app.enableShutdownHooks();
await app.closed;
```

## Publishing

```ts
import { AmqpPublisher } from '@dunx/infra/amqp';

export class Checkout {
  constructor(private readonly amqp: AmqpPublisher) {}

  async placed(id: string): Promise<void> {
    await this.amqp.publish(
      { exchange: 'shop', routingKey: 'order.created' },
      { id },
    );
  }
}
```

A string addresses a queue by name through the default exchange:
`publish('orders.created', { id })`.

Publisher confirms are on, so `publish` resolves once the broker has accepted the
message rather than once the frame was written. `AmqpOptions.publisher` turns
them off and declares whatever exchanges this app owns, re-declared on every
reconnect:

```ts
AmqpModule.forRoot({
  url,
  publisher: {
    confirm: true,
    maxAttempts: 3,
    exchanges: [{ exchange: 'shop', type: 'topic', durable: true }],
  },
});
```

For anything `publish` does not cover, `amqp.publisher()` returns the underlying
`rabbitmq-client` `Publisher`. It does not add the trace headers `publish` adds.
`connection.connection()` does the same for `queueDeclare`, `basicGet`,
`createRPCClient` and the rest.

`amqp.opened` and `connection.opened` report whether a channel or a socket has
ever been opened, and `connection.ready` reports whether the broker is reachable
right now.

### A publish is bounded

`publishTimeoutMs` caps the wait at 10 s and rejects with
`ERR_AMQP_PUBLISH_TIMED_OUT`. Against an unreachable broker `rabbitmq-client`
retries the reconnect instead of failing, so without the bound `publish()` settles
in neither direction and a route publishing inside a request holds that request
open until the client gives up. Lower it where a caller is waiting.

**The send is still in flight when the bound expires.** A caller that retries can
put the message on the broker twice, the same trade `handlerTimeoutMs` carries.

### What the connection reports

Three conditions reach the log rather than the caller, because each is the
broker's state rather than one message's:

| Line                                              | Means                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `retrying an AMQP publish`                        | A send failed and `rabbitmq-client` is attempting it again, up to `publisher.maxAttempts`                                  |
| `the broker returned a message ... as unroutable` | The exchange matched no queue. Confirms do not catch this                                                                  |
| `the AMQP broker blocked this connection`         | The broker is out of memory or disk and has stopped reading. Published messages pile up here until an unblock line follows |

## Traces cross the broker

`publish` stamps the current scope's `traceparent` and `tracestate` into the
message headers, and a consumer continues that trace with a span of its own. A
request that arrived over HTTP and a handler that ran in another service two
seconds later share a `traceId`, so their log lines join:

```json
{
  "level": "info",
  "message": "recorded order 8f2",
  "flow": "amqp",
  "event": "orders.created",
  "context": "Orders.onCreated",
  "traceId": "4bf92f3577b34da6a3ce929d0e0e4736",
  "parentSpanId": "00f067aa0ba902b7"
}
```

A header the caller set already is left alone, so forwarding a message passes the
upstream trace on. A message that arrived with no `traceparent` starts a trace at
the handler.

With `OtelModule`, `publish` and each delivery open PRODUCER and CONSUMER spans
joined through these headers. See [Tracing](./31-tracing.md#amqp).

## `handlerTimeoutMs`

```ts
AmqpModule.forRoot({ url, handlerTimeoutMs: 30_000 });
```

Rejects a handler that runs longer than this, so a delivery hung on an external
call stops holding a prefetch slot until the connection drops. AMQP has no
handler timeout of its own: an acknowledgement either arrives or does not.

A timeout is handled like a thrown error. With `consumer.requeue` on (the
default) the delivery is requeued, and with it off the delivery goes to the
dead-letter exchange.

**The handler is not cancelled, only stopped being waited for.** A timed-out call
carries on in the background after the delivery has been settled, so a handler
with side effects can run twice over one requeued message. `@dunx/infra/queue`'s `jobTimeoutMs`
behaves the same way. Make the handler idempotent, or give it a deadline of its
own that it can act on.

## Health

`AmqpIndicator` in `@dunx/http` takes `AmqpConnection` and reports readiness:

```ts
HealthModule.forRootAsync({
  // The app module that imports AmqpModule and exports AmqpConnection.
  imports: [MessagingModule],
  useFactory: (amqp: AmqpConnection) => ({
    readiness: [new AmqpIndicator(amqp)],
  }),
  inject: [AmqpConnection],
});
```

It calls `AmqpConnection.ping()`, which costs no io when the connection is ready,
throws `ERR_AMQP_UNREACHABLE` carrying the socket's own reason when it failed and
has not come back, and otherwise waits `readyTimeoutMs` for a connect already in
progress. A blocked connection counts as down.
[Health checks](./22-health-checks.md) has the rest.

## Shutdown

Teardown runs in reverse construction order, which gives three steps for free:
consumers drain, then the publisher's channel closes, then the connection closes.

`Consumer.close()` settles every in-flight handler before it returns: 701 ms for
three handlers sleeping a second, measured. That is what keeps a handler from
losing its database connection halfway through.

If the broker is gone, a `SIGTERM` still exits. Without a broker, the same call
would wait for `connection.acquireTimeout` even with nothing to drain: 19.7 s on
rabbitmq-client 5.0.8. `drainTimeoutMs` caps the wait at 10 s, and
`AmqpConnection` then destroys the socket.

## Running with no broker

A broker that is down degrades the process; it does not fail boot. A consumer
that cannot be set up within `readyTimeoutMs` is logged and left retrying, and a
container serving HTTP keeps serving.

For tests, point at a port nothing answers on and assert on the publish side:

```ts
AmqpModule.forRoot({ url: 'amqp://127.0.0.1:1', readyTimeoutMs: 50 });
```

## Queue durability

RabbitMQ 4 refuses to declare a `transient_nonexcl_queue`, failing the channel
with `INTERNAL_ERROR`. Queues are declared `durable: true` by default, and
`consumer.queueOptions` overrides that per handler.

## Errors

Everything this subpath throws is an `AmqpError`, an `AppError` carrying a `code`.
Both the class and the `AmqpErrorCode` table are exported, so a catch can branch on
the code without matching a message:

```ts
import { AmqpError, AmqpErrorCode } from '@dunx/infra/amqp';
import { HttpError } from '@dunx/http';

try {
  await this.amqp.publish(
    { exchange: 'shop', routingKey: 'order.created' },
    body,
  );
} catch (error) {
  if (
    error instanceof AmqpError &&
    error.code === AmqpErrorCode.PUBLISH_TIMED_OUT
  ) {
    throw new HttpError(503, 'the broker did not confirm');
  }
  throw error;
}
```

| Code                         | Raised when                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------ |
| `ERR_AMQP_DUPLICATE_HANDLER` | Two handlers claim one queue. Boot                                                               |
| `ERR_AMQP_NO_HANDLERS`       | `consume: true` and no `@AmqpHandler` in the graph. Boot                                         |
| `ERR_AMQP_TIMED_OUT`         | A handler outran `handlerTimeoutMs`. The delivery is nacked                                      |
| `ERR_AMQP_PUBLISH_TIMED_OUT` | A publish outran `publishTimeoutMs` with no confirm                                              |
| `ERR_AMQP_UNREACHABLE`       | `ping()` found the connection down, carrying the socket's reason                                 |
| `ERR_AMQP_INVALID_URL`       | The scheme is neither `amqp:` nor `amqps:`, or the url will not parse                            |
| `ERR_AMQP_INVALID_STATE`     | Published or subscribed after teardown, `start()` twice, or a `publishTimeoutMs` of zero or less |

## No metrics

`@dunx/infra/queue` has `QueueMetrics` under `metrics: true`. This subpath has no
counterpart.

Introspection for a RabbitMQ deployment is queue depth and what the management
plugin shows: the broker's view across every process attached to it, rather than
this process's own.

[Metrics](./24-metrics.md) covers what dunx counts, and
[architecture/message-brokers.md](../architecture/message-brokers.md)
records the comparison.

## Everything `@dunx/infra/amqp` exports

An app injects the three tokens above. The rest is for tests and custom
runtimes:

| Export                                                                    | Kind                   | For                                                                              |
| ------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| `AmqpModule`                                                              | module                 | `forRoot`, `forRootAsync`                                                        |
| `AmqpOptions`, `AmqpOptionsInit`                                          | token, type            | Resolved settings; `redactedUrl` for a log line                                  |
| `ConnectionPassthrough`, `ConsumerPassthrough`                            | types                  | What `connection` and `consumer` accept                                          |
| `AmqpConnection`                                                          | token                  | `connection()`, `ping()`, `ready`, `opened`, `createConsumer`, `createPublisher` |
| `AmqpPublisher`                                                           | token                  | `publish()`, `publisher()`, `opened`                                             |
| `AmqpHandler`                                                             | decorator              | Marks a method                                                                   |
| `AmqpMeta`                                                                | type                   | What the decorator records                                                       |
| `AmqpMessage<T>`                                                          | type                   | One delivery, `body` typed, the rest the library's                               |
| `AmqpRunner`                                                              | provider               | Opens consumers for `consume`. Bound, never exported                             |
| `AmqpSubscriber`                                                          | class                  | The consuming half: `start()`, `stop()`, `queues`                                |
| `AmqpDispatcher`, `DispatchSettings`                                      | class, type            | Runs one delivery: the timeout, the ack, the trace span                          |
| `discoverSubscriptions`, `discoverSubscriptionsOn`, `selectSubscriptions` | functions              | The prototype scan, for a test that asserts on wiring                            |
| `DiscoveredSubscription`, `AmqpHandlerFn`                                 | types                  | What discovery returns                                                           |
| `describeMessage`                                                         | function               | `<id> <queue>[<routingKey>]`, the identity every AMQP log line carries           |
| `AMQP_PROTOCOLS`, `AmqpProtocol`, `assertAmqpUrl`, `defaultAmqpUrl`       | const, type, functions | The url rules, for validating config of your own                                 |
| `AmqpError`, `AmqpErrorCode`                                              | class, codes           | The table above                                                                  |

`ConsumerStatus` is **not** re-exported, for the reason `@dunx/infra/queue` does
not re-export bullmq's `Job`: it is the library's value, and a second spelling
here would be one more name to keep in step. Import it from `rabbitmq-client`.

## Related

- [bullmq over Redis](./19-queues.md), the other backend, for retries, backoff,
  cron and a job dashboard
- [Health checks](./22-health-checks.md) for `AmqpIndicator`
- [Events](./27-events.md) for in-process events, which cross no network
- [Logging](./13-logging.md) for the `traceId` these lines carry
- [Tracing](./31-tracing.md) for the spans around publish and delivery
- `examples/full`, whose `src/messaging/` is the worked example this page is drawn
  from
