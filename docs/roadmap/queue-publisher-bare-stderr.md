# bullmq emits `error` on emitters it never listens on

**Upstream defect (bullmq 6.0.5). Reproduction ready to file.** Partly mitigated on
the dunx side; the rest cannot be.

With an unreachable broker, `JobPublisher.publish` rejects correctly **and** writes
unstructured multi-line blocks to stderr, bypassing the bound `Logger`. In an app
whose logging is JSON, that is unparseable noise interleaved with the real log.

## The cause, exactly

`bullmq/dist/cjs/classes/bun-redis-client.js:140`:

```js
this.closed = true;
this.emit('close');
if (error) {
    this.emit('error', error);
```

An `'error'` event with no listener throws rather than being ignored, and Bun prints
the raw `RedisError` to stderr. Confirmed by stack trace, not inferred:

```
RedisError: Connection closed
    at emitError (node:events:51:13)
    at <anonymous> (.../bullmq/dist/cjs/classes/bun-redis-client.js:140:22)
```

`Bun.RedisClient` on its own writes **nothing** in the same situation - measured
separately, 0 bytes - so this is bullmq's adapter and not the runtime.

## What dunx fixed

`QueueConnection` attaches an `error` listener before handing the client over, and
wraps `duplicate()` so the clients bullmq derives for blocking connections get one
too. Those errors now go to the bound `Logger` at `warn` rather than being swallowed
by a `() => undefined`, which is what was there before.

## What is left, and why dunx cannot fix it

Two errors still escape. Instrumented on bullmq 6.0.5: `QueueConnection.client()` is
called **once** and **two** unhandled errors are printed, so the emitters that throw
were constructed inside bullmq and never handed back. `JobPublisher` passes its own
client (`connection: this.#connection.client()`), so there is no further object for
dunx to attach to.

## Minimal reproduction to file upstream

```ts
import { Queue, createBunRedisClient } from 'bullmq';

const raw = new Bun.RedisClient('redis://127.0.0.1:1', {
  connectionTimeout: 300,
  maxRetries: 0,
});
const client = createBunRedisClient(raw);
client.on('error', () => undefined); // handled, and still not enough

const queue = new Queue('q', { connection: client });
await queue.add('j', {}).catch(() => undefined);
```

Expected: the rejection, and nothing on stderr. Actual: the rejection plus two raw
`RedisError` dumps.

The fix upstream is one line at each `emit('error', ...)` site: emit only when
`this.listenerCount('error') > 0`, or attach a no-op listener in the adapter's own
constructor.

## Related

Same class as the known `defaultErrorMapper` `console.error` finding: something on a
failure path reaches for the console instead of the injected `Logger`. Worth a test
asserting nothing in `@dunx/infra` writes to the console on a connection failure,
once the upstream half is resolved.
