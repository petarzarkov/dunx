# @dunx/ws

WebSocket gateways for [dunx](https://github.com/petarzarkov/dunx), on Bun's own
server sockets. Class-based gateways, standard decorators, and no topic registry —
`socket.subscribe(topic)` and `server.publish(topic, data)` are Bun's, in Zig.

Zero dependencies beyond `@dunx/core`. No `ws`, no `socket.io`.

## Install

```bash
bun add @dunx/ws @dunx/core
```

## Usage

```ts
import { Module } from '@dunx/core';
import {
  Gateway,
  OnClose,
  OnMessage,
  OnOpen,
  PubSub,
  WsFactory,
  WsModule,
  type Socket,
} from '@dunx/ws';

@Gateway('/chat')
export class ChatGateway {
  constructor(private readonly pubsub: PubSub) {}

  @OnOpen()
  opened(socket: Socket) {
    socket.send('welcome');
  }

  @OnMessage('chat.join')
  join(room: string, socket: Socket) {
    socket.subscribe(room); // Bun's own pub/sub
    return { joined: room }; // returned values are replied to the sender
  }

  @OnMessage('chat.say')
  say(payload: { room: string; text: string }) {
    this.pubsub.publishEvent(payload.room, 'chat.said', payload.text);
  }

  @OnClose()
  closed(socket: Socket, code: number) {
    console.log(`${socket.data.path} closed with ${code}`);
  }
}

@Module({
  imports: [WsModule.forRoot({ port: 3000, gateways: [ChatGateway] })],
})
export class AppModule {}

const app = await WsFactory.create(AppModule);
app.enableShutdownHooks();
await app.listen();
```

A gateway is a normal injectable class — constructor injection, `inject()`, and
`OnInit`/`OnShutdown` all work, because the container builds it like anything else.

## Handlers

| Decorator          | Signature                             | Notes                                                         |
| ------------------ | ------------------------------------- | ------------------------------------------------------------- |
| `@Gateway(path)`   | class                                 | Exact pathname. Optional; defaults to `/`                     |
| `@OnUpgrade()`     | `(req: Request)`                      | Return a `Response` to refuse; anything else becomes `context` |
| `@OnOpen()`        | `(socket)`                            |                                                               |
| `@OnMessage(event)`| `(data, socket)`                      | Routed by envelope event name                                 |
| `@OnMessage()`     | `(message: string \| Buffer, socket)` | The raw catch-all                                             |
| `@OnClose()`       | `(socket, code, reason)`              |                                                               |
| `@OnDrain()`       | `(socket)`                            | Backpressure relieved                                         |
| `@OnPing()`        | `(data, socket)`                      | Bun still answers with a pong                                 |
| `@OnPong()`        | `(data, socket)`                      |                                                               |

Handlers may be `async`. A returned value is sent to the sender — under the same
event name for `@OnMessage(event)`, verbatim (or JSON) for the raw handler, and
never for a lifecycle handler. Return `undefined` to send nothing.

`socket` is Bun's `ServerWebSocket`, unwrapped: `send`, `subscribe`,
`unsubscribe`, `isSubscribed`, `subscriptions`, `publish`, `cork`, `ping`,
`close`, `getBufferedAmount` are its own methods. `socket.data.path` is the
gateway path; `socket.data.context` is whatever `@OnUpgrade` returned.

### Discovery, and what is a boot error

Handlers are discovered at boot by walking each gateway instance's prototype
chain, so an abstract base gateway's handlers are inherited by every subclass and
an undecorated override still dispatches to the override. Nothing is read per
message: the handler table, the `websocket` object, and the upgrade closure are
built once.

Three things throw at boot rather than picking a winner:

- two handlers claiming one event or one lifecycle slot, named individually
- two gateways on one path, named individually
- a registered gateway with no handlers at all

## The envelope

Named events need a way to say which event a frame is, so `@dunx/ws` defines the
smallest one that works:

```json
{ "event": "chat.say", "data": { "room": "general", "text": "hi" } }
```

It is **opt-in**: a frame is only parsed for a gateway that declares at least one
`@OnMessage(event)` handler. A gateway with only a raw `@OnMessage()` never sees
JSON it did not ask for. Binary frames, invalid JSON, a non-object, a missing
`event`, and an event no handler claims all fall through to the raw handler — and
are ignored if there is none. Nothing is ever replied to the sender that a handler
did not return.

`encode(event, data)` and `decode(frame)` are exported, so a client can share
them.

### Typed payloads

```ts
@OnMessage('chat.say')
say(payload: { room: string; text: string }) {}
```

The parameter type is what you expect to receive, not a guarantee — the decorator
cannot validate at runtime, and schema validation is a later phase. Nothing casts
it behind your back either: the frame's `data` is handed over as it arrived.

## Pub/sub

Topics live in Bun, not in a JavaScript map. A socket joins one with
`socket.subscribe(topic)` and leaves with `socket.unsubscribe(topic)`; both are
native methods on the socket you already hold.

`PubSub` is the injectable side, for publishing without a socket:

```ts
class Notifier {
  constructor(private readonly pubsub: PubSub) {}

  ship(version: string) {
    this.pubsub.publishEvent('releases', 'shipped', { version }); // envelope
    this.pubsub.publish('releases', 'raw frame'); // string or BufferSource
    return this.pubsub.subscriberCount('releases');
  }
}
```

`publish` returns the bytes sent, `0` if the message was dropped, `-1` under
backpressure — Bun's own status. Publishing before the server is listening throws
with that as the message.

## Options

```ts
WsModule.forRoot({
  gateways: [ChatGateway],
  port: 3000, // WsFactory's own Bun.serve only
  idleTimeout: 120, // seconds; Bun rejects anything above 960
  maxPayloadLength: 16 * 1024 * 1024,
  backpressureLimit: 1024 * 1024,
  closeOnBackpressureLimit: false,
  perMessageDeflate: true,
  publishToSelf: false,
  sendPings: true,
  onError: (error, socket) => console.error(socket.data.path, error),
});
```

Everything below `port` is Bun's `websocket` option of the same name, and the type
is `Pick`ed from Bun's own so the two cannot drift. `WsModule.forRootAsync({
gateways, useFactory, inject })` is the same registration with the options from a
factory — resolution is eager, so an async factory settles before any constructor
runs. The resolved options are bound to the `WsSettings` token and injectable.

`onError` catches a throwing or rejecting handler; the default logs. The socket
stays open.

## Using it with @dunx/http

`@dunx/ws` never calls `Bun.serve` unless you use `WsFactory`. The integration
point is one function:

```ts
import { AppFactory } from '@dunx/core';
import { createWsAdapter } from '@dunx/ws';

const app = await AppFactory.create(AppModule);
const ws = createWsAdapter(app); // { websocket, upgrade, handles, attach, paths }

const server = Bun.serve({
  routes,
  websocket: ws.websocket,
  fetch: (req, server) => ws.upgrade(req, server) ?? notFound(),
});
ws.attach(server); // lets PubSub publish before the first connection
```

- `websocket` is the object `Bun.serve` consumes, built at boot.
- `upgrade(req, server)` returns `undefined` when the socket was upgraded — return
  that from `fetch` — or a `Response`: `404` for a path no gateway serves, `426`
  for a non-upgrade request, or whatever `@OnUpgrade` refused with. It may return a
  promise if a gateway's `@OnUpgrade` is async.
- `handles(req)` is the cheap check for whether the request is a gateway's at all,
  for a host that wants to keep its own 404.
- `paths` is every mounted path.

When `@dunx/http` adopts this, `HttpApp.listen()` is where the two objects meet:
one `Bun.serve` with `routes`, `websocket`, and a `fetch` fallback that tries the
upgrade first.

## Notes

- Paths are matched exactly — `@Gateway('/chat/:room')` is not a pattern, because
  Bun's native router does not run on the upgrade path and dunx does not ship a
  JavaScript one. Use a query parameter (`/chat?room=general`) or a topic.
- `shutdown()` forces the server to stop. A graceful `Bun.serve` stop waits for
  open connections, and a WebSocket does not close on its own, so it would hang;
  clients see a `1006` close.
- Bun delivers an empty close `reason` to `@OnClose` once the socket has exchanged
  frames, whatever the client passed. The `code` is reliable.

## License

MIT
