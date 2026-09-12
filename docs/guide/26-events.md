# Events

```ts
import {
  AppEvent,
  EventBus,
  EventBusModule,
  Module,
  OnEvent,
} from '@dunx/core';

export class OrderPlaced extends AppEvent {
  constructor(
    readonly id: string,
    readonly total: number,
  ) {
    super();
  }
}

export class Orders {
  constructor(private readonly bus: EventBus) {}

  async place(total: number): Promise<void> {
    await this.bus.emit(new OrderPlaced(crypto.randomUUID(), total));
  }
}

export class Audit {
  @OnEvent(OrderPlaced)
  async record(event: OrderPlaced): Promise<void> {
    await this.rows.insert(event.id, event.total);
  }
}

@Module({ imports: [EventBusModule, OrdersModule, AuditModule] })
export class AppModule {}
```

`EventBusModule` is `global: true`. Import it once from the app root; `Audit`'s
module never names `Orders`.

## Events are classes

Extend `AppEvent` and call `super()` with no arguments. The dispatch name comes
from `new.target` and is kept in a `WeakMap`, so a minifier that renames the
class does not change which listeners it reaches, and two features may both
call theirs `Created`.

The handler's parameter has to accept the event class. A field removed from an
event is a compile error at every subscriber.

## emit resolves when the handlers do

`emit` calls `EventTarget.dispatchEvent`: every listener runs synchronously, in
registration order, before `emit` returns its promise. That promise then waits
for the work those listeners left outstanding.

| Handler shape                         | Awaited by `emit` |
| ------------------------------------- | ----------------- |
| `handle(e) { ... }`                   | nothing to await  |
| `async handle(e) { ... }`             | yes               |
| `handle(e) { e.waitUntil(promise); }` | yes               |
| `handle(e) { void promise; }`         | no                |

`dispatchEvent` discards a listener's return value. `EventBus` collects it
instead, so an `async` handler needs no `waitUntil`. Reach for `waitUntil` when a
synchronous handler starts work it does not return, and call it before the
handler returns.

```ts
@OnEvent(OrderPlaced)
notify(event: OrderPlaced): void {
  event.waitUntil(this.mailer.send(event.id));
}
```

## A failing subscriber does not fail the publisher

`emit` never rejects. A handler that throws, or returns a rejecting promise, is
caught, counted on its subscription, logged at `error` naming the subscriber,
and carried on the returned `EventDispatch`. The subscribers registered after it
still run.

```ts
const dispatch = await bus.emit(new OrderPlaced(id, total));

dispatch.handled; // subscribers that ran to completion
dispatch.ok; // false when any failed
dispatch.failures; // [{ subscriber: 'Audit.record', error }]
dispatch.throwIfFailed(); // one error as itself, several as an AggregateError
```

A rejected `waitUntil` promise is recorded under the subscriber name
`waitUntil`.

## Subscribing without a decorator

```ts
const subscription = bus.on(OrderPlaced, (event) => this.seen.push(event.id), {
  as: 'Feed.tail',
  signal: connection.signal,
});

subscription.unsubscribe();
```

| Option   | Effect                                                         |
| -------- | -------------------------------------------------------------- |
| `once`   | Unsubscribes after the first delivery. `bus.once(...)` sets it |
| `signal` | Unsubscribes when it aborts, alongside `unsubscribe()`         |
| `as`     | The name used in logs, `EventRegistry.list()` and in a failure |

Removal is `addEventListener(..., { signal })`. `unsubscribe()` is idempotent.

`@OnEvent(Event, { once: true })` is the decorator form of `once`.

## What is wired

`EventRegistry` subscribes every `@OnEvent` in the graph during `onInit`, then
lists what it created.

```ts
registry.list(); // every discovered subscription, in discovery order
registry.subscribersOf(OrderPlaced); // just that event's
```

Each entry carries `event`, `subscriber`, `handled`, `failed`, `lastError` and
`active`.

Discovery walks the prototype chains of the classes each module declares in
`providers` and `controllers`, so a handler needs no second registration and an
abstract base's marked methods are inherited by every subclass. A value or
factory provider is not scanned: put handlers on a class provider.

## Limits

Handlers are wired during `onInit`. An event emitted from a constructor reaches
nobody.

The bus is in process and single node. Nothing here survives a restart or
crosses a replica.

| Need                                     | Use                                              |
| ---------------------------------------- | ------------------------------------------------ |
| Survives a restart, retries, runs later  | `@JobHandler` - [Queues](./15-queues.md)         |
| A websocket message every node must send | `PubSubRelay` - [WebSockets](./09-websockets.md) |
| Decoupling two services in one process   | `EventBus`                                       |
