# Defects in bullmq's Bun adapter and `Bun.RedisClient`

**Open, and it is three upstream bugs, not one dunx bug.** Two are the SIGTERM hang
this file was opened for; the third is unrelated in symptom and shares their cause -
`createBunRedisClient` does things ioredis's driver does automatically, and misses
some of them.

The first investigation attributed the hang entirely to bullmq. That was half wrong:
bisecting the stack a layer at a time found a leak in `Bun.RedisClient` on its own,
and a second, separate one in bullmq's Bun adapter. Neither is reachable from
userland. All three have a minimal reproduction, ready to file.

| #                                                                          | Symptom                                                                       | Layer          |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------- |
| [A](#leak-a---bun-a-connect-that-never-completes-outlives-close)           | a pending connect outlives `close()`, process hangs                           | Bun            |
| [B](#leak-b---bullmq-disconnect-cannot-cancel-its-own-reconnect)           | `disconnect()` cannot cancel its own reconnect                                | bullmq adapter |
| [C](#defect-c---no-connection-is-ever-named-so-getworkers-is-always-empty) | ~~`getWorkers()` always `[]`~~ **fixed - was dunx's own `duplicate` wrapper** | dunx           |

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

## Defect C - no connection is ever named, so `getWorkers()` is always empty

> **FIXED, and it was dunx's, not upstream's.** The diagnosis below is correct up to
> the blame: no connection is named, dashboards say "No workers". The cause is that
> `QueueConnection.#handleErrors` wrapped `duplicate` and called it with **no
> arguments**, and bullmq's Bun adapter takes the connection name only through
> `duplicate({ connectionName })`. Forwarding the arguments makes `CLIENT SETNAME`
> run; measured against a real Redis, `CLIENT LIST` gains the named connection and
> `getWorkers()` goes from 0 to 1. Nothing upstream had to change.

**Cosmetic, but permanently and visibly wrong**, and the first of these three that a
user actually reports. Found from `dunx-template`: its Bull Board showed two queues
with waiting jobs and **"No workers"** next to each, while a worker was consuming
them.

The workers were fine. Measured on the template, with one `bun src/worker.ts`:

| Observation                               | Result                            |
| ----------------------------------------- | --------------------------------- |
| `notifications` before the worker started | 56 waiting, 0 completed           |
| `notifications` ~8 s after it started     | **0 waiting, 56 completed**       |
| `CLIENT LIST` while consuming             | 8 clients, two of them `bzpopmin` |
| `name=` on every one of those 8 clients   | **`""`**                          |
| `getWorkers()` / the board's worker count | **0**                             |

So the blocking connections are there and draining jobs, and not one of them has a
name.

`getWorkers()` is name matching and nothing else. From
`bullmq/dist/cjs/classes/queue-getters.js`:

```js
getWorkers() {
  const unnamedWorkerClientName = `${this.clientName()}`;
  const namedWorkerClientName = `${this.clientName()}:w:`;
  const matcher = (name) => name &&
    (name === unnamedWorkerClientName || name.startsWith(namedWorkerClientName));
  return this.baseGetClients(matcher);   // -> backend.getClientList() -> CLIENT LIST
}
```

With every name empty, `matcher` is false for every client, so the result is always
`[]`.

**It is not a Bun limitation.** `CLIENT SETNAME` works and is visible from another
connection, which is exactly what `CLIENT LIST` needs:

```ts
const a = new Bun.RedisClient('redis://127.0.0.1:6379');
await a.send('PING', []);
await a.send('CLIENT', ['SETNAME', 'probe:test']); // -> 'OK'
await a.send('CLIENT', ['GETNAME']); // -> 'probe:test'
// and a second client's CLIENT LIST shows `name=probe:test`
console.log(a.url); // -> undefined  (see below)
```

Both halves of the plumbing exist, too, which is what makes this a wiring bug rather
than a missing feature:

- `createBlockingConnection` in `bullmq/dist/cjs/utils/create-backend.js` computes the
  right name - `` `${prefix}:${base64(queueName)}${workerName ? `:w:${workerName}` : ''}` `` -
  and passes it as `duplicate({ connectionName })`.
- `BunRedisAdapter.duplicate()` reads `opts.connectionName` onto the new adapter, and
  its `onconnect` handler calls `clientSetName(this.connectionName)` before emitting
  `'ready'`.
- `onconnect` does fire, on an explicit `connect()` **and** on the implicit connect of
  a first command (measured both).

The name still never lands. The remaining suspect is which branch
`createBlockingConnection` takes - `isRedisInstance(opts.connection)` decides between
`.duplicate({ connectionName })` and `Object.assign({}, opts.connection, { connectionName })`,
and the second would spread the adapter into a plain options bag and never call
`duplicate` at all. Confirming that is the last step before filing, and it did not
finish here because instantiating the adapter to test it hangs the process on leak A.

Worth noting alongside: `Bun.RedisClient` exposes **no `url` property**
(`a.url === undefined`, above), and `duplicate()` is `new BunRedisClient(this.raw.url)`.
`@dunx/infra/queue`'s url-carrying subclass is what keeps that from silently
connecting to Bun's default, and it is why the duplicate above reaches the right
server at all.

**Not worked around in `@dunx/infra/queue`.** Naming the connection from userland means
reproducing bullmq's private client-name convention, base64 and suffix included, on a
connection bullmq then duplicates internally - so the name would land on the wrong
socket and break on a patch release. That is the same reasoning that keeps leak B's
`closing = true` cast out of the package.

Consumers should know the panel is wrong rather than have dunx guess: **"No workers"
on a Bun-backed board means nothing about whether workers are running.** Job counts
moving is the signal that works.

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

## Contained, on the dunx side

**The symptom is handled; the two leaks are still open upstream.**
`enableShutdownHooks()` no longer guarantees only a drain - once the drain
finishes it ends the process, via an `unref()`d timer in `ShutdownHooks`
(`packages/core/src/di/shutdown-hooks.ts`). An unref'd timer cannot hold the
runtime open, so a process with nothing pending still exits immediately and the
callback never runs; it fires only when something else is holding the loop, which
after a completed teardown is by definition a handle dunx does not own. Verified
on Bun 1.3.14 and recorded in [bun-apis.md](../bun-apis.md).

That covers **any** leaked handle, not just these two, which is why it is the right
layer: dunx cannot enumerate what a dependency leaks.

What it does not do is make the leaks go away. A forced exit skips whatever that
client would have done with a working connection, and it logs a line saying so.

## Options left

- File leak A with Bun and leak B with bullmq. Both reproductions above are
  self-contained.
- Re-measure the table on every Bun and bullmq bump; either fix alone shrinks it.
  When both land, the forced exit should stop firing for this cause - the warning
  it logs is how you would notice.
