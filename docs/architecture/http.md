# The HTTP layer

The Bun.serve adapter, how routes are discovered, and multi-node websocket fan-out.

## HTTP adapter (`@dunx/http`)

`HttpFactory.create(RootModule, options?)` boots the container via
`AppFactory.create`, then:

1. Collect controllers from `@Module({ controllers })` across the import graph
2. Discover routes per controller by walking the constructed instance's prototype
   chain (see **Route discovery**). Zero routes throws
3. Join controller prefix + method path, normalize
4. **Detect collisions and throw** - Bun silently lets one route win
5. Build the `routes` object; each handler is a closure over the
   already-constructed instance and its bound method, with the middleware chain
   already folded in
6. Hand to `Bun.serve`

Step 2 needs the instance, not just the class, so that the handler can be bound off
it - which is what makes an undecorated override in a subclass dispatch correctly.
That ordering is guaranteed: container resolution is eager and completes first.

Field-initialized routes are part of **Route discovery** but not yet implemented:
the thing that produces them is the `route.*` builder, which exists to sidestep the
decorator inference limit, so it lands with Phase 3 rather than as a scan with no
producer.

Middleware is a **class** with `handle(req, ctx, next)`, resolved from the container
so it gets constructor injection. It has three homes, one per scope it can belong
to: `HttpFactory.create` / `app.use()` for app-wide, `@Module({ middleware })` for
the routes that module's own controllers declare, and `@UseGuards(...)` for a class
or a method.

Ordering is global outermost, then the declaring module's, then class-level, then
method-level, then validation, then the handler - and back out through all of it.
There is no ancestor layer: importing a module never changes the request path of the
importer's routes. `packages/http/src/server/lifecycle.test.ts` pins the whole order
in one request.

### The framework's own services are bound, not self-bound

`HttpFactory` wraps the app's root in a `global: true` module that binds and exports
`PubSub`, `ClientAddress` and `RequestLoggingMiddleware`. Two of those could be left
to self-binding under the flat container and cannot be under scoping: an unbound class
self-binds into **whichever scope asks first**, so a second module injecting
`ClientAddress` was a boot error naming the first module, and even with one consumer
`listen()` could attach the live server to an instance nothing else held. They are
framework services with no module for an app to import, which is exactly what the
global scope is for. `packages/http/src/server/client-address.test.ts` pins it.

Per request the framework does exactly four things: validate declared schemas,
call the method, pass a `Response` through or wrap the return in
`Response.json()`, and map thrown errors. No lookup, no DI, no metadata read -
route metadata and the `RouteContext` join the **boot-time** set, not the
per-request one. The context is frozen and shared by every request to its route, and
`ctx.get` is a `Map` lookup over an already-merged record rather than a prototype
walk.

## Route discovery

Both original candidates were measured and both fail - see **Verified
constraints**. `ctx.metadata` is unreadable without polyfilling `Symbol.metadata`
and shares mutable state up the prototype chain. A global pending array drained by
the class decorator hands a base class's routes to whichever subclass is defined
first, and leaks decorated methods across files.

Both were **accumulators**: they recorded routes at class-definition time and
needed a class decorator to close the record. Every failure above traces to that.
So stop accumulating.

A method decorator sets a symbol property on the function it receives and returns
it. Nothing is recorded anywhere else. At boot the adapter _discovers_ routes by
inspection:

1. Walk `Object.getPrototypeOf` from the controller's prototype, reading
   `Object.getOwnPropertyDescriptors` at each level. A marked `descriptor.value`
   is a route; most-derived wins on a repeated name.
2. Read `Object.entries(instance)` for field-initialized `route.*` builders, which
   carry the same marker.

Consequences, all measured:

- **No accumulator, so no ordering dependence and no cross-file leak.** An
  undecorated class's marked methods are never reached, because its prototype is in
  no other class's chain.
- **No class decorator is required at all** - and so no `@Routes()`. Inheriting
  from an undecorated abstract base works for any number of subclasses.
  `@Controller` is reduced to supplying a prefix and may be omitted;
  `@Module({ controllers })` is what registers a controller. The prefix is read
  through the prototype chain rather than with `Object.hasOwn`, so a subclass
  inherits its base's prefix and two subclasses of one decorated base collide
  loudly at boot instead of silently mounting at the root.
- **Overriding a decorated base method without re-decorating works.** The own
  undecorated member does not shadow discovery, and dispatch resolves through the
  prototype chain to the override.
- **Decorated methods and field routes are one merged set**, so collision
  detection covers both and a controller resolving to zero routes can throw.

No `Symbol.metadata`, no polyfill, no import-order dependence.

### Declined: trailing-slash normalisation

`GET /t` is a 200 and `GET /t/` is a 404, and Nest, Express and Fastify all
normalise, so it is the one thing that breaks a ported client - as a 404 that reads
like a missing route. It stays a 404, and the reason is where the two candidate
implementations would have to live.

`joinPath` already normalises the **declared** side, so `@Get('sub/')` is `/t/sub`
and both spellings are never live at once. The inbound side is Bun's: by the time
anything in dunx can see that nothing matched, it is inside the `fetch` fallback,
which holds middleware and the error mapper and **no route patterns**. Stripping the
slash and re-dispatching there means matching `/t/7/` against `/t/:id` in
JavaScript, which is the router this repo will not write. Registering `/t/` as a
second entry in the `Bun.serve` table was the other option - native, and free per
request - and was rejected as blast radius: it doubles a table that collision
detection, gateway-path checking and the CORS `OPTIONS` mounting all walk, to buy
an alias a proxy rewrite can supply.

So it is documented in guide 05 and pinned by a test in `server.test.ts`, which is
what makes it a decision rather than an oversight.

## Multi-node websocket fan-out (`@dunx/http`)

`PubSub.publish` is `server.publish`, which is Bun's own pub/sub and therefore
per-process. Two nodes behind a load balancer each fan out to their own sockets and
to nobody else's. The fix is a relay: publish locally **and** hand the message to
the other nodes, which then publish locally too.

### The contract is two methods, and it lives in `@dunx/http`

```ts
interface PubSubRelay {
  publish(channel: string, message: string): unknown;
  subscribe(channel: string, listener: (message: string) => void): unknown;
  close?(): unknown;
}
```

Default: nothing. With no relay configured `PubSub` is byte-for-byte the code it was
before - one `server.publish` call and no branch that costs anything measurable.

The Redis-backed implementation, `RedisRelay`, uses **`Bun.RedisClient` directly**.
It is a Bun global, so this adds **zero dependencies** to `@dunx/http`, which still
depends only on `@dunx/core`.

**The rejected alternative was putting it in `@dunx/infra/redis`**, where the
connection handling, retry policy and error classification already exist. It was
rejected on the dependency direction: the relay has to be reachable from `PubSub`,
`PubSub` is `@dunx/http`, and `@dunx/infra` must not depend on the web layer. That
coupling has now been refused three times - for the request logger, for `@dunx/auth`,
and here - for the same reason each time: `@dunx/infra` is what a CLI script, a
seeder or a queue worker imports, and none of those have an HTTP server.

The cost accepted is a small amount of **relay-specific connection glue** that does
not reuse `@dunx/infra/redis`'s general-purpose client: URL validation, the
`maxRetries` default, lazy client creation, and unsubscribe-before-close. That is
about 60 lines, and it buys a package with one dependency.

An app that would rather reuse its existing connections satisfies the two methods
itself - and `@dunx/infra`'s `RedisConnection` **already does, structurally**:
`publish(channel, message)` and `subscribe(channel, listener)` are its own names and
shapes, so `app.get(PubSub).relayThrough(app.get(RedisConnection))` typechecks with
no adapter between them. That is the `@dunx/auth` `RedisStore` precedent - declare
the shape, let the app supply anything that fits - and `examples/full` runs its
second node that way on purpose.

### One channel, because `psubscribe` does not work

Frames for **every** topic travel on one broker channel, not one channel per topic.
Two reasons, both forced:

- A node cannot know which topics its sockets joined. `socket.subscribe(topic)` goes
  straight into Bun, and there is no hook and no way to enumerate it - so
  subscribing to a Redis channel when a topic gains its first local member is not
  implementable.
- `psubscribe` is unusable on Bun 1.3.14 (see [bun-apis.md](../bun-apis.md)), so a
  wildcard subscription is not available either.

The cost is that every node reads every relayed frame and drops the ones for topics
it has no local subscriber on - a `server.publish` returning `0`. Two apps sharing
one Redis need two channels, which is what `relayChannel` is for.

### Duplicate delivery is the failure mode, and an origin id is the defence

Redis delivers a published message to **every** subscriber of the channel, the
publishing application included - a relay's own subscribe connection receives what
its publish connection just sent. Fanning that out locally a second time would
deliver twice to every client on the publishing node, which is worse than not having
the feature.

So every frame carries the publishing process's id (`Bun.randomUUIDv7`, once per
`PubSub` instance) and the inbound path drops a frame whose origin is its own. The
other half of the rule is that the inbound path calls `server.publish` and
**nothing else** - re-relaying there would put the frame back on the channel that
delivered it, forever.

`relayThrough` throws on a second call rather than replacing the relay: two
subscriptions on one channel is the other way to get every message twice.

The guard is a test that asserts **exactly one** delivery per subscriber with
relaying on - `packages/http/src/ws/relay.test.ts`, once over an in-memory bus and
once over real Redis with two `Bun.serve` instances and a client on each. Both fail
with two frames if the origin check is removed, which was verified by removing it.

### Two connections, and why `maxRetries` defaults to 0

A `Bun.RedisClient` in subscriber mode rejects every data command and throws
synchronously doing it, so the subscription cannot share the socket that publishes.
`RedisRelay` opens two, lazily - the same `pubClient`/`subClient` split
`nestjs-template`'s socket.io adapter makes.

`maxRetries` defaults to `0` because a client that never connects keeps a retry
timer alive past `close()` and **the process then never exits**. A relay is exactly
the connection most likely to be absent, so the default has to be the one that lets
an app boot, degrade and still exit. Raising it opts into Bun's reconnection and
accepts that hazard.

`maxRetries: 0` is not sufficient on its own, and finding out cost real time. Two
further `Bun.RedisClient` behaviours hold the event loop open past `close()`, and the
symptom of both is a service that shut down cleanly and then hangs forever:

- a client that **entered** subscriber mode - fixed by `unsubscribe()` before
  `close()`;
- a `subscribe()` that **failed to connect** - fixed by `connect()` before
  `subscribe()`, which fails first and releases cleanly. `unsubscribe()` cannot
  rescue this one, because the client is not in subscriber mode.

Both were already latent in `@dunx/infra/redis` and are fixed there too. The
measurements are in [bun-apis.md](../bun-apis.md). The guards have to be **spawn-based
tests**: `bun test` exits the runner process itself, so a held-open event loop is
invisible from inside the suite - which is exactly why this survived until an example
app tried to shut down.

Absence is tolerated at every step: a failed subscribe reports once and leaves local
fan-out untouched; a failed publish reports once and not again until one succeeds;
the app boots either way. A malformed **URL**, by contrast, throws at construction -
that is a config bug, and degrading silently would turn a typo into single-node
fan-out nobody notices.

### What the relay does not cover

`socket.publish(topic, data)` is Bun's own method on the socket and does not go
through `PubSub`, so it stays local. Anything that must cross nodes goes through
`PubSub`. `subscriberCount` is local too - Bun counts its own sockets and cannot
count another node's.
