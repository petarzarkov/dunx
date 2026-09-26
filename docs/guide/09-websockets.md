# WebSockets

A gateway is a class in `providers` with `@Gateway('/path')` on it. It is served
by the **same `Bun.serve` call** as the HTTP routes, from the same container, with
the same constructor injection.

The exception is `gatewayPort`. It serves the upgrades from a second `Bun.serve`
that always speaks HTTP/1.1. Set it when you use `http2` with `http1: false`,
because a websocket upgrade is an HTTP/1.1 request. See
[Deployment](./21-deployment.md#http1-false-and-gateways).

```ts
import { Logger } from '@dunx/core';
import {
  Gateway,
  HttpStatusCode,
  OnClose,
  OnDrain,
  OnMessage,
  OnOpen,
  OnPing,
  OnPong,
  OnUpgrade,
  type Socket,
} from '@dunx/http';
import type { BunRequest } from 'bun';

@Gateway('/chat')
export class ChatGateway {
  constructor(
    private readonly lobby: Lobby,
    private readonly logger: Logger,
  ) {}

  @OnUpgrade()
  upgrade(req: BunRequest): Response | { nickname: string } {
    const nickname = new URL(req.url).searchParams.get('as') ?? 'anonymous';
    if (nickname === 'banned') {
      return new Response('nope', { status: HttpStatusCode.FORBIDDEN });
    }
    return { nickname };
  }

  @OnOpen()
  opened(socket: Socket): void {
    socket.subscribe(Lobby.TOPIC);
    socket.send('welcome');
  }

  @OnMessage('say')
  say(text: string): { delivered: number } {
    return { delivered: this.lobby.broadcast(text) };
  }

  @OnClose()
  closed(socket: Socket, code: number): void {
    this.logger.info(`${socket.data.path} closed with ${code}`);
  }
}
```

```ts
@Module({ providers: [ChatGateway, Lobby] })
export class ChatModule {}
```

Nothing else registers it. `HttpFactory.create()` walks the module graph, finds
every class marked `@Gateway`, and `listen()` mounts the upgrade.

## The upgrade is a real route

`server.upgrade(req)` works from inside a `routes` handler, and Bun's own types
say so. So a gateway is mounted as a native `GET` route in the same table as
everything else, rather than needing a hand-written `fetch` fallback.

Three consequences:

- **Bun's router runs on the upgrade path.** A gateway path may be a pattern, and
  `req.params` is readable inside `@OnUpgrade`.
- **A plain `GET` on a gateway path is a 426**, because the upgrade was refused
  by Bun rather than by a missing route.
- **A path claimed by both a controller and a gateway is a boot error** naming
  both, since the two tables merge and one of them would be silently dropped.

`app.gatewayPaths` lists every path this app upgrades on, exactly as mounted.
`setGlobalPrefix()` moves **routes only**. The prefix applies to discovered
controller routes, and a gateway path stays what the decorator said.

## The lifecycle decorators

| Decorator            | Handler signature                                | Notes                                                                                                      |
| -------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `@OnUpgrade()`       | `(req: BunRequest) => Response \| unknown`       | Before the socket exists. Return a `Response` to refuse.                                                   |
| `@OnOpen()`          | `(socket: Socket) => void`                       | The socket is live.                                                                                        |
| `@OnMessage(event?)` | `(data, socket) => unknown`                      | With a name, routed by envelope; without, the raw catch-all.                                               |
| `@OnClose()`         | `(socket, code: number, reason: string) => void` |                                                                                                            |
| `@OnDrain()`         | `(socket: Socket) => void`                       | Backpressure relieved; safe to resume sending.                                                             |
| `@OnPing()`          | `(data, socket: Socket) => void`                 | Observation only; Bun still answers with a pong. `data` is a `Buffer` by default and follows `binaryType`. |
| `@OnPong()`          | `(data, socket: Socket) => void`                 | `data` follows `binaryType` the same way.                                                                  |

Every handler may be synchronous or `async`. A returned promise is adopted, and a
rejection goes to the same error handler a synchronous throw does.

`@OnPing` and `@OnPong` are installed on Bun's handler object **only when a
gateway declares them**. Bun answers a ping with a pong on its own, and overriding
the handler with a no-op would take that away.

### `@OnUpgrade` is where per-connection state is declared

Whatever it returns that is not a `Response` becomes `socket.data.context`:

```ts
@OnUpgrade()
upgrade(req: BunRequest): Response | { nickname: string } {
  ...
  return { nickname };
}

@OnOpen()
opened(socket: Socket<{ nickname: string }>): void {
  socket.send(`welcome, ${socket.data.context.nickname}`);
}
```

Returning a `Response` refuses the upgrade, and it is the only place a connection
can be refused. A gateway has no `@UseGuards`: the request has not become a
socket yet, so the thing to run is a plain function call inside `@OnUpgrade`.

## `Socket`

```ts
export interface SocketData<T = unknown> {
  readonly path: string;
  readonly context: T;
  /** Minted per connection at the upgrade, with `crypto.randomUUID()`. */
  readonly id: string;
}

export type Socket<T = unknown> = ServerWebSocket<SocketData<T>>;
```

That is a type alias over **Bun's native socket, unwrapped**. `send`, `subscribe`,
`unsubscribe`, `isSubscribed`, `publish`, `cork` and `close` are Bun's own methods
and nothing here reimplements them. Whatever the Bun documentation says a
`ServerWebSocket` does is what this does.

`socket.data.path` is the gateway the socket upgraded on, and `socket.data.context`
is whatever `@OnUpgrade` returned.

Server-wide options are on `HttpOptions.websocket`, `Pick`ed from Bun's own
`WebSocketHandler` type rather than restated, so the names cannot drift from the
runtime:

```ts
await HttpFactory.create(AppModule, {
  websocket: { idleTimeout: 30, maxPayloadLength: 64 * 1024 },
});
```

It accepts Bun's `backpressureLimit`, `closeOnBackpressureLimit`, `idleTimeout`,
`maxPayloadLength`, `perMessageDeflate`, `publishToSelf` and `sendPings`, and two
options of dunx's own.

`onError` receives any error a handler throws or rejects with. The default logs it
with `console.error`, including the gateway path.

`binaryType` sets what a binary frame arrives as:

```ts
await HttpFactory.create(AppModule, {
  websocket: { binaryType: 'blob' },
});
```

The values are `'nodebuffer'` (the default, a `Buffer`), `'arraybuffer'`,
`'uint8array'` and `'blob'`. dunx sets it on each socket as it opens, before the
gateway's `@OnOpen` runs. It only affects **binary** frames. Text frames, such as
JSON, still arrive as strings.

Bun types `message` as the default's, because the runtime type is chosen at run
time. A gateway that set this narrows the value itself:

```ts
@OnMessage()
async record(message: string | Buffer): Promise<number> {
  if (typeof message === 'string') return 0;
  const blob = message as unknown as Blob;
  return blob.size;
}
```

They are server-wide rather than per gateway because Bun's `websocket` object is
server-wide. Gateways themselves are declared in `@Module({ providers })`.

## The envelope

The wire protocol is one JSON object:

```ts
export interface Envelope {
  readonly event: string;
  readonly data?: unknown;
}
```

A client sends `{"event":"say","data":"hello"}`; the frame is routed to
`@OnMessage('say')` and the handler receives the `data` alone. If the
handler returns a value other than `undefined`, that value is sent back to the
sender under the **same event name**:

```ts
@OnMessage('say')
say(text: string): { delivered: number } {
  return { delivered: this.lobby.broadcast(text) };
}
```

That replies to the caller. Broadcasting is `PubSub`, below.

Decoding is skipped entirely for a gateway that declares no named handlers. A
gateway with only a raw `@OnMessage()` never parses anything:

```ts
@OnMessage()
raw(message: string | Buffer, socket: Socket): void { ... }
```

Anything that is not a valid envelope falls through to the raw handler rather than
being rejected: binary frames, invalid JSON, a non-object, or an object with no
`event` string. If there is no raw handler either, the frame is dropped. A raw
handler's return value is sent as-is when it is a string or binary, and
`JSON.stringify`d otherwise.

Two handlers claiming the same slot is a boot error naming both:

```
Handler collision in ChatGateway: message "say" is claimed by say() and by speak().
One handler per event.
```

So is a `@Gateway` with no handlers at all, and two gateways on one path.

## Pub/sub: topics live in the runtime

`socket.subscribe(topic)` is Bun's own method. Bun keeps track of which sockets
are on which topic, and dunx keeps no copy of that in JavaScript.

So a node cannot list which topics its sockets joined. The relay below is built
around that.

### `PubSub`

Publishing from a service that holds no socket is the common case, so `PubSub` is
injectable. `HttpFactory` binds it around your root module, so nothing has to be
imported or registered:

```ts
import { PubSub } from '@dunx/http';

export class Lobby {
  static readonly TOPIC = 'lobby';

  constructor(private readonly pubsub: PubSub) {}

  broadcast(text: string): number {
    return this.pubsub.publishEvent(Lobby.TOPIC, 'said', text);
  }
}
```

Listing `PubSub` in your own `providers` raises the container's duplicate-binding
error.

| Member                              | Does                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `publish(topic, data, compress?)`   | `server.publish`. Bytes sent locally, `0` if dropped, `-1` under backpressure. |
| `publishEvent(topic, event, data?)` | The same envelope `@OnMessage(event)` reads.                                   |
| `subscriberCount(topic)`            | Subscribers on **this** node only.                                             |
| `origin`                            | This process's id on the relay channel.                                        |
| `attached` / `relaying`             | Whether `listen()` has run, and whether a relay is configured.                 |
| `relayThrough(relay, options?)`     | Opt into multi-node fan-out.                                                   |
| `close()`                           | Releases a relay this `PubSub` owns.                                           |

`PubSub.publish` is `server.publish`, which **reaches the sender**.
`socket.publish` does not, absent `publishToSelf`. The two are not
interchangeable, and mixing them up is the usual reason a client does not see its
own message. Publishing before `listen()` throws with a message saying so, rather
than dropping the frame.

## Multi-node fan-out

`server.publish` is per process. Two nodes behind a load balancer each fan out to
their own sockets and to nobody else's. The fix is a relay: publish locally
**and** hand the message to the other nodes, which then publish locally too.

The contract is two methods:

```ts
export interface PubSubRelay {
  publish(channel: string, message: string): unknown;
  subscribe(channel: string, listener: (message: string) => void): unknown;
  close?(): unknown;
}
```

The return types are `unknown` because the implementations disagree: Bun's
`publish` resolves the subscriber count, `@dunx/infra`'s resolves nothing, and an
in-memory bus resolves nothing at all. A returned promise is awaited by `subscribe` and watched for rejection by
`publish`; anything else is taken as having succeeded.

`close?` is optional. Omitting it is how a relay says it does not own the
connections and should not close them: a relay built on the application's own
shared `RedisConnection` must leave that to the container.

### The batteries-included one

```ts
import { HttpFactory, RedisRelay } from '@dunx/http';

const app = await HttpFactory.create(AppModule, {
  relay: new RedisRelay({ connectionTimeout: 500 }),
  relayChannel: 'my-app:ws',
});
```

### The same relay from the container

`WsRelayModule` binds the relay as a provider, so its url comes off
`ConfigService` like everything else and the container closes it at shutdown:

```ts
@Module({
  imports: [
    WsRelayModule.forRootAsync({
      useFactory: (config: AppConfigService) => ({
        url: config.get('redis').url,
        connectionTimeout: 500,
      }),
      inject: [AppConfigService],
    }),
  ],
  providers: [provide(HttpOptionsProvider, { useClass: AppHttpOptions })],
})
export class HttpConfigModule {}
```

```ts
import { HttpOptionsProvider, WsRelay, type PubSubRelay } from '@dunx/http';

export class AppHttpOptions extends HttpOptionsProvider {
  constructor(private readonly bus: WsRelay) {
    super();
  }

  override get relay(): PubSubRelay {
    return this.bus;
  }
}
```

To write your own relay, extend `WsRelay`, bind it, and return your transport from
the `relay` getter as above. It needs no module. See
[Configuration](./12-configuration.md) for the options provider.

### Postgres instead of Redis

`WsRelayModule.forPostgres` and `forPostgresAsync` bind `PostgresRelay`, which
carries the same frames over `LISTEN`/`NOTIFY` on `Bun.SQL`. An app already running
Postgres needs no broker for fan-out:

```ts
WsRelayModule.forPostgresAsync({
  useFactory: (config: AppConfigService) => ({
    url: config.get('database').url,
  }),
  inject: [AppConfigService],
});
```

The factory changes with the method: `PostgresRelayOptions` is `url` and `max`, so
Redis-only settings like `connectionTimeout` do not carry across. The injection site
does not change, because both relays are bound under `WsRelay`. Which method you
call has to be decided up front, though: a binding is fixed once the module graph
is built, so it cannot be read from config the container resolves later.

Switching from Redis changes two things. **A frame over about 7.9 KB does not
cross**, because Postgres caps a `NOTIFY` payload at 7999 bytes and the envelope
adds a topic and an origin id to it; `PubSub` logs one warning and fan-out stays
local for that message. And `LISTEN`/`NOTIFY` is Postgres only, so `Bun.SQL`'s
SQLite and MySQL adapters reject it.

`RedisRelay` uses `Bun.RedisClient`, which is built into Bun, so you install
nothing extra. With no `url`, it uses the same fallback as Bun's client:
`$VALKEY_URL`, then `$REDIS_URL`, then `redis://localhost:6379`.

A URL with an unknown scheme throws when the relay is created. Without this check,
Bun would accept the URL and fail later with `Connection closed`. The relay would
read that as "Redis is down" and send messages to this node's clients only,
without an error.

It opens **two** connections. A `Bun.RedisClient` in subscriber mode rejects every
data command and throws synchronously doing it, so the subscription cannot share
the socket that publishes. This is the same split the socket.io Redis adapter
makes.

`maxRetries` defaults to **`0`**, and that default is not a preference. A
`Bun.RedisClient` that never connects keeps an internal retry timer alive past
`close()`, and the process then never exits. A relay is the connection most
likely to be absent, so the default lets the app boot, degrade, and still exit.
Raise it when Redis is a hard requirement.

### Reusing a connection you already have

You can pass `@dunx/infra`'s `RedisConnection` as the relay. It already has both
methods `PubSubRelay` needs. It comes from the container, so call `relayThrough`
after the app is created instead of setting the option:

```ts
const app = await HttpFactory.create(AppModule);
await app.get(PubSub).relayThrough(app.get(RedisConnection), {
  channel: 'my-app:ws',
});
await app.listen();
```

`relayThrough` throws on a second call rather than replacing the relay: two
subscriptions on one channel is another way to get every message twice.

### One channel for every topic

Every topic's frames travel on a single broker channel, `dunx:ws` by default.

Two things force it. A node cannot know which topics its sockets joined, because
`socket.subscribe` goes straight into Bun. And pattern subscription is not an option:
`Bun.RedisClient.psubscribe(pattern)` is accepted, but unlike
`subscribe(channel, listener)` it takes no listener - passing one throws - and the
client exposes no hook for pattern messages. Re-checked on Bun 1.4.2.

The cost is stated plainly: **every node reads every relayed frame** and drops the
ones for topics it has no local subscriber on, which is a `server.publish`
returning `0`. Two applications sharing one Redis need two channels; pass
`relayChannel`.

### `origin`, and why a node does not fan out its own echo

Redis delivers a published message to **every** subscriber of the channel, the
publishing application included: a relay's own subscribe connection receives what
its publish connection just sent. Fanning that out locally a second time would
deliver twice to every client on the publishing node, which is worse than not
having the feature at all.

So every frame carries the publishing process's id:

```ts
readonly #origin = Bun.randomUUIDv7();
```

and the inbound path drops a frame whose origin is its own:

```ts
#inbound(message: string): void {
  const frame = decodeRelay(message);
  if (!frame || frame.origin === this.#origin) return;
  this.#server?.publish(frame.topic, frame.data);
}
```

`Bun.randomUUIDv7` rather than a counter, because two nodes booted in the same
millisecond must not collide.

The inbound path only calls `server.publish`. It never relays again, which would
send the frame back to the channel it came from, in a loop.

Each relayed frame is sent as `{ o, t, d }`, plus `b: 1` when `d` is base64. Binary
frames are base64-encoded because Bun cannot yet subscribe to a channel in buffer
mode. A message in any other shape is ignored, so a channel can carry other
traffic too.

`@dunx/http`'s relay tests check that each subscriber gets **exactly one** copy
with relaying on, over an in-memory bus and over real Redis with two `Bun.serve`
instances. Without the origin check, both tests see two copies.

### `resubscribe`: retrying the boot subscribe

Publishing recovers on its own, because every publish retries the broker. A failed
**subscribe** used to be retried by nothing, so a node whose broker was briefly
down at boot stayed permanently deaf to the other nodes while still looking
healthy. `RelayOptions.resubscribe` fixes that:

```ts
await app.get(PubSub).relayThrough(relay, {
  channel: 'my-app:ws',
  resubscribe: { attempts: 5, delayMs: 500 },
  onError: (error, phase) => logger.warn(`relay could not ${phase}`, { error }),
});
```

| Field      | Default | Meaning                                           |
| ---------- | ------- | ------------------------------------------------- |
| `attempts` | `5`     | Retries after the first failure. `0` disables.    |
| `delayMs`  | `500`   | First delay. Doubles each attempt, capped at 30s. |

Bounded rather than infinite, and the timer is `unref`'d, so a broker that never
comes back can neither hold the process open nor spin forever. A successful
subscribe cancels the remaining attempts; `close()` cancels a pending one before
anything can await, so a retry can never fire against a relay being closed.

### Degrading

A broker that cannot be reached is reported through `onError` and otherwise left
alone. Local fan-out is unaffected and the app boots either way. `onError` is
called **once** when the relay starts failing and not again until it works, so an
unreachable broker cannot flood the log. When `HttpOptions.relay` is used, the
default `onError` routes through the app's `Logger` at `warn`:

```
the websocket relay could not subscribe. Fan-out is local to this process until it recovers.
```

### What the relay does not cover

`socket.publish(topic, data)` is Bun's own method on the socket and does not go
through `PubSub`, so it stays local. Anything that must cross nodes goes through
`PubSub`. `subscriberCount` is local too: Bun counts its own sockets and cannot
count another node's.

## Shutdown

A graceful `server.stop()` **never resolves while a WebSocket is open**, because
it waits for open connections and a WebSocket does not close on its own. So an app
with gateways force-stops:

```ts
await this.#server?.stop(this.#websocket !== undefined);
```

Those clients observe close code **1006**. There is no way around it without
hanging, and an app that hangs on `SIGTERM` gets `SIGKILL` anyway.

`PubSub.close()` runs **before** the container shuts down, and closes the two
Redis sockets of a relay the app owns. Nothing else closes them.

It also drops its reference to the server. `PubSubRelay` has no unsubscribe, so
on a shared connection a frame can still arrive after this node has stopped.
With no server, that frame goes nowhere, so it is safe to leave the relay
subscribed.

`enableShutdownHooks()` wires `SIGTERM` and `SIGINT` to all of it.

## Sharp edges

- **`PubSub.publish` before `listen()` throws.** `listen()` is what attaches the
  server. Publish from `onInit` and you get an `AppError` saying exactly that.
- **`server.publish` reaches the sender, `socket.publish` does not.** Absent
  `publishToSelf`, these are different operations.
- **`setGlobalPrefix` does not move gateways.** Only controller routes are
  prefixed.
- **`idleTimeout` is in seconds** and Bun rejects anything above 960 at
  `Bun.serve` time.
- **A handler that throws does not close the socket.** It goes to
  `websocket.onError` and the connection stays up.
- **Two gateways on one path, two handlers in one slot, and a gateway with no
  handlers are all boot errors.**
- **The event-name reply goes to the sender only.** Returning a value from
  `@OnMessage('x')` replies; it does not broadcast.

Next: [OpenAPI](./10-openapi.md).
