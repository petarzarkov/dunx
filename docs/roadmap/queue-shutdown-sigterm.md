# A process that touched an unreachable Redis will not exit on SIGTERM

**Open, and it is two upstream bugs, not one dunx bug.** The last investigation
attributed it entirely to bullmq. That was half wrong: bisecting the stack a layer
at a time found a leak in `Bun.RedisClient` on its own, and a second, separate one
in bullmq's Bun adapter. Neither is reachable from userland. Both have a minimal
reproduction below, ready to file.

## The measurement that separates them

Same process each time: construct a client, attempt one operation, tear down, then
`SIGTERM` it and wait 12 s. `connectionTimeout: 2000, maxRetries: 0` throughout.

| server                                         | plain `Bun.RedisClient` | `createBunRedisClient` over it | a bullmq `Queue` on it |
| ---------------------------------------------- | ----------------------- | ------------------------------ | ---------------------- |
| healthy (`127.0.0.1:6379`)                     | exits 0 in ~100 ms      | exits 0 in ~100 ms             | exits 0 in ~110 ms     |
| refused (`127.0.0.1:6399`, nothing listening)  | exits 0 in ~100 ms      | **never exits**                | **never exits**        |
| black-holed (`10.255.255.1:6379`, SYN dropped) | **never exits**         | **never exits**                | **never exits**        |

Two independent leaks fall straight out of that table. The healthy row is clean at
every layer, which is why this has never affected a normal deployment.

## Leak A - Bun: a connect that never completes outlives `close()`

No bullmq involved. A `Bun.RedisClient` pointed at an address that neither accepts
nor refuses the connection keeps the event loop alive after `close()`.

```ts
// bun repro.ts, then SIGTERM it - it will not die.
const client = new Bun.RedisClient('redis://10.255.255.1:6379', {
  connectionTimeout: 2000,
  maxRetries: 0,
});
await client.send('PING', []).catch(() => undefined);
// RedisError [ERR_REDIS_CONNECTION_TIMEOUT]: Connection timeout reached after 2000ms
client.close();
```

Measured on Bun 1.3.14, and none of these change it: `maxRetries: 0`,
`autoReconnect: false`, `enableOfflineQueue: false` (which rejects in 10 ms without
waiting and still hangs, so it is the socket and not the command queue),
`connectionTimeout: 500`, calling `close()` twice, calling `close()` while the
connect is still pending, or waiting six seconds after `close()` before exiting.
`construct` and `close()` with no connect attempt is clean, and a **refused**
connection is clean - so the handle is the pending connect itself.

This is the same family as the two already in
[bun-apis.md](../bun-apis.md) (subscriber mode, and a failed `subscribe`), and it
affects `@dunx/infra/redis` exactly as much as it affects the queue.

## Leak B - bullmq: `disconnect()` cannot cancel its own reconnect

`BunRedisAdapter` in `bullmq/dist/esm/classes/bun-redis-client.js` runs its own
reconnect loop on a `setTimeout` chain (`_scheduleReconnect`, floor 1000 ms,
exponential to 20 s). A dropped connection sets `closed = true` and schedules one.
Both public ways out then refuse to run:

```js
disconnect(reconnect) {
  if (this.closed && !reconnect) { return; }   // <- returns before clearing the timer
  ...
}
async quit() {
  if (this.closed) { setImmediate(...); return 'OK'; }   // <- same
}
```

So once the connection has dropped - which is precisely when a reconnect is
pending - nothing exposed on `IRedisClient` can cancel it, each attempt fails and
reschedules, and the process never exits.

```ts
import { createBunRedisClient } from 'bullmq';
// Nothing listens on 6399. Plain Bun.RedisClient exits cleanly here; this does not.
const raw = new Bun.RedisClient('redis://127.0.0.1:6399', {
  connectionTimeout: 2000,
  maxRetries: 0,
});
const adapter = createBunRedisClient(raw);
adapter.on('error', () => undefined);
await adapter.get('probe').catch(() => undefined);
adapter.disconnect(); // no-op: `closed` is already true
raw.close();
```

A userland escape hatch exists but is a cast through `unknown` into a field bullmq
does not export - `closing = true` plus `clearTimeout(reconnectTimer)`. That is a
fork by another name and it would break on a patch release, so it is **not** in
`@dunx/infra/queue`. Fix it upstream, or wait for it.

## What was fixed on the way, and is shipped

The roadmap's first option - "bound bullmq's own client harder at construction" -
did not cure the hang, but it did turn up two real bugs, both now fixed in
`packages/infra/src/queue/connection.ts`.

`createBunRedisClient(client, opts)` takes only `{ lazyConnect }`, so there is no
way to hand it connection options. bullmq does not keep the client it is given
either: a `Worker`'s blocking connection is `connection.duplicate()`, and both that
and the reconnect above rebuild with `new (this.raw.constructor)(this.raw.url)`.

- **The options were dropped**, so `maxRetries: 0` applied to the first socket only.
- **The url was dropped too.** `Bun.RedisClient` exposes no `url` property on Bun
  1.3.14, so `this.raw.url` is `undefined` and the replacement silently resolved
  Bun's default (`$VALKEY_URL`, `$REDIS_URL`, `valkey://localhost:6379`). A worker
  pointed at a remote Redis was block-polling localhost. Demonstrated: an adapter
  built on a client for `127.0.0.1:6399` produced a duplicate whose `GET` **answered
  `null`**, which only a different, live server could have done.

A `Bun.RedisClient` subclass that carries the url and reapplies the options fixes
both, because every one of those constructions goes through `this.raw.constructor`.
`packages/infra/src/queue/module.test.ts` guards it, and fails without the subclass.

That fix also removed the accident that used to mask leak B on a refused port: the
old duplicate connected to a healthy localhost, so the reconnect loop terminated.
With the duplicate correctly aimed at the refused port, the loop no longer does.

## Options left

- File leak A with Bun and leak B with bullmq. Both reproductions above are
  self-contained.
- Re-measure the table on every Bun and bullmq bump; either fix alone shrinks it.
- Document it as a deployment note, which
  [17-deployment.md](../guide/17-deployment.md) already does: set a grace period
  short enough that `SIGKILL` arrives promptly if a deploy can race Redis being
  down.
