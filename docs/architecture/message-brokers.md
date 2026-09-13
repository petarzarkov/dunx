# Message brokers

Why `@dunx/infra/amqp` is a second module tree rather than a `driver` option on
`QueueModule`, which library it sits on, and what was measured to decide both.

Raised as [issue #105](https://github.com/petarzarkov/dunx/issues/105), which
asked for RabbitMQ and RocketMQ behind the existing queue API. The library survey
behind the first half is in `internal/notes/research/brokers.md`, which had
already measured the candidates and set the gate at "an issue from someone who is
not the owner".

## No unified queue abstraction

The issue sketched one API with a transport underneath:

```ts
QueueModule.forRoot({ driver: 'rabbitmq', url });
```

That shape does not survive contact with either backend's semantics. Four
differences, each one a promise a shared option object would have to break on one
side:

| Concern       | bullmq over Redis                                      | RabbitMQ                                                  |
| ------------- | ------------------------------------------------------ | --------------------------------------------------------- |
| Retry         | `attempts` plus a backoff strategy bullmq applies      | redelivery is the broker's, driven by nack and requeue    |
| Delay         | `delay` on the job, held in a sorted set               | needs the delayed-message-exchange plugin, or a TTL queue |
| Failure       | a `failed` state with a stored stack and a retry count | a dead-letter exchange, or discard                        |
| Routing       | a queue name the publisher picks                       | an exchange, a type and a binding key the broker matches  |
| Introspection | job counts, a state model, bull-board                  | queue depth, and what the management plugin shows         |

`JobsOptions` has no AMQP equivalent for three of its five common fields. A
`publish(queue, name, data, { attempts: 3, backoff, delay })` against a RabbitMQ
driver either throws on settings the broker cannot honour, or accepts them and
does nothing, or dunx reimplements bullmq's retry machinery over AMQP. The third
is the failure Rule 1 names: inventing what a mature library already solves.

The same conclusion, reached from Kafka rather than from bullmq, is in
`internal/notes/research/brokers.md` under "One abstraction, two modules, or
neither", with ordering, acknowledgement, failure and drain measured against real
brokers.

So: two module trees, two decorators, two message types, no shared transport
token. `@dunx/infra/queue` owns work this process created for itself to do later.
`@dunx/infra/amqp` owns messages whose consumers this process does not know about.

## rabbitmq-client over amqplib

Both run fully under Bun. `rabbitmq-client` 5.0.8 was picked on four measurements
taken against `rabbitmq:4-alpine`:

|                 | `rabbitmq-client` 5.0.8         | `amqplib` 2.0.1                |
| --------------- | ------------------------------- | ------------------------------ |
| Dependencies    | 0                               | 0                              |
| Unpacked        | 197.70 KB                       | 546.24 KB                      |
| Types           | bundled `lib/*.d.ts`            | bundled, plus `@types/amqplib` |
| Consumer object | yes, with `close()` that drains | no; a channel API              |

The deciding one is the last. `Consumer.close()` waits for in-flight handlers:
701 ms measured for three handlers each sleeping a second, with all three acked
before it resolved. `amqplib` has no consumer object to close, so dunx would track
in-flight deliveries itself to get the same shutdown ordering, which is machinery
this avoids owning.

The historical "Invalid frame" breakage (`oven-sh/bun#5627`, `#14032`) is fixed
and was re-measured rather than trusted: 1 KB, 64 KB, 128 KB, 1 MB and 8 MB bodies
round trip byte-exact on both clients.

## What dunx contributes

Handler discovery, the container lifecycle, one log line per delivery, and three
things the library leaves to the caller.

**A throw never reaches the library.** `rabbitmq-client` nacks a throwing handler
and re-emits the error on the `Consumer`, which carries `queue` and nothing else:
no message id, no routing key, no handler name. `AmqpDispatcher` catches, logs one
line naming the delivery and the method, and returns the nack the library would
have sent.

**The drain is bounded.** `Consumer.close()` needs the connection to close its
channel, so against a broker that has gone away it waits `acquireTimeout` with
nothing in flight to drain:

```text
$ bun close.probe.ts          # amqp://127.0.0.1:1, nothing listening
[20004ms] consumer.close() resolved after 19701ms
[20004ms] connection.close() resolved after 0ms
EXIT 0 at 20004ms
```

`drainTimeoutMs` caps that at 10 s and `AmqpConnection.onShutdown` calls
`unsafeDestroy()` afterwards either way, so a `SIGTERM` against an absent broker
exits. Compare `internal/notes/roadmap/queue-shutdown-sigterm.md`, where the
equivalent Redis path does not exit at all: every AMQP shutdown path measured here
released the event loop.

## Bounding a close

Five sites bound one: the three above, `JobEvents` closing a `QueueEvents`
stream, and `QueueConsumer` draining a worker that reached readiness before a
later queue failed to. All five call `closeWithin` in `packages/infra/src`, which
answers whether the bound expired and leaves the warning to the caller.

They were five hand-written copies of the same race until issue #127. Two fixes
had reached one copy each and neither had been carried across: `unref` on the
timer, and the `clearTimeout` that stops a resource which closed at once from
holding the loop open for the rest of the window. That second one had cost a clean
shutdown 2.37 s against 0.36 s where it was missing.

`@dunx/dashboard`'s `bounded` is a sixth of the same shape and stays where it is.
It bounds a read during a request and answers with a value a panel renders, where
these bound a close during teardown and answer with a verdict. Sharing the four
lines under them means either `@dunx/dashboard` depending on `@dunx/infra`, which
it does not, or a timeout primitive on `@dunx/core`'s public surface.

### Why a race and not a signal

`ResiliencePolicy` bounds its own operation with `AbortSignal.timeout` combined
with the caller's through `AbortSignal.any`, and says so. Every close here does
the opposite, and the two hold together rather than contradicting.

A signal bounds an operation that reads it. `ResiliencePolicy` awaits
`op(signal)` rather than racing it, so an `op` that ignores its signal runs to
completion and the bound does nothing - documented in
[the resilience guide](../guide/25-resilience.md). That is a cost worth paying for
work the caller wrote.

None of the five closes takes a signal. bullmq's `Worker.close(force?)` and
`QueueEvents.close()` take no argument that cancels, and neither do
rabbitmq-client's `Consumer`, `Publisher` and `Connection` closes. So there is
nothing to hand a signal to, and a bound that has to settle against a library that
will not cooperate can only be a race. The rule both halves follow: **a signal
where the operation takes one, a race where it does not.**

What a signal would change is the handler timeout - `jobTimeoutMs` and
`handlerTimeoutMs`, where the work is the consumer's own method and could read
one. Today it is not cancelled, only stopped being waited for, so a handler that
outran its bound can act twice on one unit of work. Both
[guide 15](../guide/15-queues.md) and [guide 28](../guide/28-message-brokers.md)
say so. Changing that is cooperative cancellation through the handler signature,
not a change to how the bound is measured.

**Traces cross the broker.** `AmqpPublisher.publish` stamps the scope's
`traceparent` and `tracestate` into the message headers and `AmqpDispatcher`
continues that trace with a span of its own. Nothing in `@dunx/infra/queue` does
this: `JobPublisher.publish` passes `data` through untouched and `JobDispatcher`
calls the handler with no `runWithContext`.

The format was already implemented in `@dunx/http`'s `TraceContext`, which parses
the inbound header. Per Rule 2 the parse and format pair moved down to `@dunx/core`
as `parseTraceparent` and `formatTraceparent`, next to the `RequestFields` they
fill; `TraceContext` now calls them and keeps the request and response halves.

## RocketMQ

Not shipped. Issue #105 asked for it alongside RabbitMQ, and the client was
measured against `apache/rocketmq:5.3.2` (namesrv, broker and proxy) on Bun 1.4.2
and Node 20.20.2.

`rocketmq-client-nodejs` 1.0.8 is Apache's own, published 2026-09-07. It loads and
runs under Bun, and `Producer` plus `SimpleConsumer` work identically on both
runtimes: a message produced and received in 7 ms, acked, clean shutdown in 3 ms,
exit 0 at 67 ms.

`PushConsumer` does not work on either:

```text
$ node push.probe.mjs                    $ bun push.probe.ts
[36ms]    push consumer started          [41ms]    push consumer started
[49ms]    produced 1                     [56ms]    produced 1
[15066ms] after wait: got=0              [15073ms] after wait: got=0
[22083ms] shutdown after 7017ms          [22093ms] shutdown after 7020ms
                 ... killed at 90s; the exit marker never ran
```

The listener receives nothing, `shutdown()` takes 7 s, and the process never
exits. Node behaves the same way, so this is the library rather than Bun, and it
is not reachable from dunx.

Two smaller costs, also on both runtimes: the client writes an `egg-logger` file
to `~/logs/rocketmq/` and then throws `log stream had been closed` during
shutdown, and importing it prints `can't get mac address` to stderr. The first has
a seam - `BaseClientOptions.logger` takes anything with `info`, `warn` and
`error`, which core's `Logger` satisfies structurally - so dunx could fill it.

What that leaves is a subpath whose only working consumer is a receive-and-ack
loop dunx would drive itself, on a client with a broken push API. The gate in
`docs/ROADMAP.md` is a user first; one issue naming two brokers is one user. The
triggers for building it, any one sufficient:

1. `PushConsumer` delivering messages on a released `rocketmq-client-nodejs`.
2. Someone who runs RocketMQ asking for it specifically.
3. A second issue, or a reference implementation to port rather than design.
