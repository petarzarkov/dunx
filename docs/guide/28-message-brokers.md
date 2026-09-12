# Message brokers

**RabbitMQ is the broker, and `rabbitmq-client` is the client.**
`@dunx/infra/amqp` contributes the four things neither has an opinion about:
where a handler lives, how it is found, how it is injected, and when it stops. It
writes no AMQP framing, no retry policy and no dead-letter helper.

```bash
bun add rabbitmq-client
```

An **optional peer dependency**, so an app using only `@dunx/infra/files`
installs nothing.

## When this rather than `@dunx/infra/queue`

The two sit side by side and neither replaces the other. The test is who owns the
failure.

| Ask                                                        | Reach for                                                |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| Retry with backoff, a rate limit, a cron, a job dashboard  | [`@dunx/infra/queue`](./15-queues.md), bullmq over Redis |
| A payload another deployable consumes, broker-side routing | `@dunx/infra/amqp`                                       |

A unit of work this process created for itself to do later is a job. A message
whose consumers this process does not know about is a message. An app can hold
both, and `examples/full` does.

There is no `driver: 'rabbitmq'` switch on `QueueModule`. bullmq's `attempts`,
`backoff` and `delay` have no AMQP equivalent, so a shared option object would
accept settings one backend silently ignores. The measurements are in
[architecture/message-brokers.md](https://github.com/petarzarkov/dunx/blob/main/docs/architecture/message-brokers.md).

## A handler is a method with a decorator

That is the whole registration. No class decorator, no registry, no queue token.

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

Declare `Orders` in a module's `providers` and it is found by inspection, the
same way a `@JobHandler`, a route or a gateway is.

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

`queue`, `exchange` and `routingKey` cover the common binding. Anything else
`rabbitmq-client` takes goes in `consumer`, forwarded verbatim:

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

`forRootAsync` reads the url off `ConfigService`:

```ts
AmqpModule.forRootAsync({
  imports: [ConfigModule],
  useFactory: (config: AppConfigService) => ({ url: config.get('amqp').url }),
  inject: [AppConfigService],
});
```

The module binds `AmqpOptions`, `AmqpConnection` and `AmqpPublisher`, and opens
no socket until the first publish.

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

`amqp.publisher()` hands back the `rabbitmq-client` `Publisher` for anything this
does not wrap. `connection.connection()` does the same for `queueDeclare`,
`basicGet`, `createRPCClient` and the rest.

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

## `handlerTimeoutMs`

```ts
AmqpModule.forRoot({ url, handlerTimeoutMs: 30_000 });
```

Rejects a handler that runs longer than this, so a delivery hung on an external
call is nacked and redelivered instead of holding a prefetch slot until the
connection drops. AMQP has no handler timeout of its own: an acknowledgement
either arrives or does not.

**The handler is not cancelled, only stopped being waited for.** A timed-out call
carries on in the background while the delivery is redelivered, so a handler with
side effects can run twice over one message. `@dunx/infra/queue`'s `jobTimeoutMs`
behaves the same way. Make the handler idempotent, or give it a deadline of its
own that it can act on.

## Shutdown

Teardown runs in reverse construction order, which gives three steps for free:
consumers drain, then the publisher's channel closes, then the connection closes.

`Consumer.close()` settles every in-flight handler before it returns: 701 ms for
three handlers sleeping a second, measured. That is what keeps a handler from
losing its database connection halfway through.

The same call waits `connection.acquireTimeout` when the broker has gone away,
with nothing in flight to drain: 19.7 s on rabbitmq-client 5.0.8. `drainTimeoutMs`
bounds it at 10 s and `AmqpConnection` destroys the socket afterwards either way,
so a `SIGTERM` against an absent broker still exits.

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

## Related

- [Queues](./15-queues.md) for bullmq over Redis: retries, backoff, cron, a dashboard
- [Events](./26-events.md) for in-process events, which cross no network
- [Logging](./13-logging.md) for the `traceId` these lines carry
