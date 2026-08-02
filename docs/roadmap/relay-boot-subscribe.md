# Redis as the WebSocket adapter

**Delivered, kept here for the one part that is still open.**

The relay itself is built: `RedisRelay`, `PubSub.relayThrough`, the `origin` field
that stops a node fanning out its own echoed frame twice, and two-node fan-out
verified in the full example.

`RelayOptions.resubscribe` now retries a failed boot subscribe with doubling
backoff, five attempts by default, capped at 30 s, on an unref'd timer that
`close()` cancels. Before that a node whose subscribe failed at boot stayed
permanently deaf to every other node while still looking healthy, because
publishing recovers on its own.

## What is still open

Nothing in the relay. The remaining question is the **design of the boundary**,
recorded here because it was resolved by a workaround rather than a decision:

`PubSub` lives in `@dunx/http` and the Redis client in `@dunx/infra/redis`, and
`@dunx/infra` must not depend on the web layer. The current answer is that
`@dunx/http` declares the minimal structural `PubSubRelay` interface and
`@dunx/infra`'s connection satisfies it without either importing the other. That
works and matches the `DrizzleSource` and `RedisStore` precedent.

The reason to revisit: it is the third place that pattern appears, and a third
occurrence is usually the point at which a shared contract earns its keep. A relay
contract in `@dunx/core` was rejected once as a stretch for core, which it is. Leave
it unless a fourth appears.
