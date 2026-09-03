# Defects in bullmq's Bun adapter and `Bun.RedisClient`

**Leak A is fixed in Bun 1.4. Leak B is still live, and is not a Bun defect.**
Three bugs, of which two were the SIGTERM hang this file was opened for; the third
was dunx's own and is fixed.

## Correction: leak B is bullmq's, on every runtime

This file spent its life calling leak B a defect in bullmq's **Bun adapter**. It is
not. Narrowed on Bun 1.4.0 and bullmq 6.0.5:

| Object                    | Connection             | Runtime | Exits? |
| ------------------------- | ---------------------- | ------- | ------ |
| `Queue` + `add` + `close` | `createBunRedisClient` | Bun     | yes    |
| `Worker` + `close`        | `createBunRedisClient` | Bun     | **no** |
| `Worker` + `close`        | ioredis                | Bun     | **no** |
| `Worker` + `close`        | ioredis                | Node 24 | **no** |

Six lines reproduce it, with no dunx and no Bun:

```js
import { Worker } from 'bullmq';
const worker = new Worker('probe', async () => {}, {
  connection: { host: '127.0.0.1', port: 6399, maxRetriesPerRequest: 0 },
});
await new Promise((r) => setTimeout(r, 300));
await worker.close();
```

Two things follow. **The `Worker` is the leak and the `Queue` is clean**, which the
earlier three-layer table could not see because it only ever built a `Queue`. And
the ioredis-on-Node row removes Bun from the report altogether, so this belongs
upstream at bullmq rather than at oven-sh/bun.

`close(true)`, `disconnect()` after `close()`, and both together were each measured
and none releases the loop. There is no userland workaround, so `ShutdownHooks`'
forced exit stays until bullmq fixes it.

**Filed as [taskforcesh/bullmq#4656](https://github.com/taskforcesh/bullmq/issues/4656).**
`close()` is pending rather than rejected, and what holds the loop is three armed
ioredis retry timers with no live socket, so the `await disconnecting` in
`redis-connection.js` waits on an `end` that a reconnecting client never emits.
That is the same un-timed await
[#4065](https://github.com/taskforcesh/bullmq/issues/4065) identifies for
`pause()`, reached from a single worker and a server that was never up. Reproduced
on bullmq 6.3.2 as well as the 6.0.5 this repo pins.

## Re-measured on Bun 1.4.0 (rev 34cbb9a40), bullmq 6.0.5

The file's own instruction is to re-measure on every Bun and bullmq bump. Half the
table moved.

| Case                                                     | 1.3.14      | 1.4.0                  |
| -------------------------------------------------------- | ----------- | ---------------------- |
| Leak A repro verbatim (black-holed, plain `RedisClient`) | never exits | **exits 0 in 2008 ms** |
| Leak B repro verbatim (refused, `createBunRedisClient`)  | never exits | exits 0 in 1081 ms     |
| A real dunx app: `QueueModule` on a refused Redis        | never exits | **never exits**        |

**Leak A is gone.** A pending connect no longer outlives `close()`; the process ends
one `connectionTimeout` after the attempt, which is the correct behaviour and needs
no workaround. The three-layer table's black-holed row is clean at the plain-client
layer for the first time.

**Leak B is not gone, and the verbatim repro no longer demonstrates it.** Two
lines of raw adapter now happen to exit after a single reconnect attempt, so that
snippet is no longer the test. The test is the last row: `AppFactory.create` with
`QueueModule.forRoot({ url: <refused> })`, `enableShutdownHooks(['SIGTERM'], {
exitAfterMs: false })`, SIGTERM to self - killed at 25 s. With the default
`exitAfterMs` the forced exit fires and logs its warning, which is how you notice.
So the reproduction to file upstream is the dunx app, not the snippet below.

`@dunx/core`'s `ShutdownHooks` bounds the symptom: after the drain completes an
`unref()`d timer gives the process 1000 ms to exit on its own and then calls
`process.exit`, logging first. A deployment therefore no longer pays its full
termination grace on every rollout. **Leak B is still live**, so that mitigation
stays; when it is fixed the default becomes zero.

The first investigation attributed the hang entirely to bullmq. That was half wrong:
bisecting the stack a layer at a time found a leak in `Bun.RedisClient` on its own,
and a second, separate one in bullmq's Bun adapter. Neither is reachable from
userland. All three have a minimal reproduction, ready to file.

| #                                                                          | Symptom                                                                       | Layer  |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| [A](#leak-a---bun-a-connect-that-never-completes-outlives-close)           | ~~a pending connect outlives `close()`~~ **fixed in Bun 1.4**                 | Bun    |
| [B](#leak-b---bullmq-disconnect-cannot-cancel-its-own-reconnect)           | a `Worker` on an unreachable server holds the loop after `close()`            | bullmq |
| [C](#defect-c---no-connection-is-ever-named-so-getworkers-is-always-empty) | ~~`getWorkers()` always `[]`~~ **fixed - was dunx's own `duplicate` wrapper** | dunx   |

## The measurement that separated them

Same process each time: construct a client, attempt one operation, tear down, then
see whether the process exits by itself. `connectionTimeout: 2000, maxRetries: 0`
throughout. **`SIGTERM` is the wrong instrument here** and an earlier version of this
table used it: the default disposition terminates the process whatever is holding the
loop, so every cell reads "exits". Natural exit is the measurement.

On Bun 1.3.14, where two independent leaks fell straight out of it:

| server                                         | plain `Bun.RedisClient` | `createBunRedisClient` over it | a bullmq `Queue` on it |
| ---------------------------------------------- | ----------------------- | ------------------------------ | ---------------------- |
| healthy (`127.0.0.1:6379`)                     | exits 0 in ~100 ms      | exits 0 in ~100 ms             | exits 0 in ~110 ms     |
| refused (`127.0.0.1:6399`, nothing listening)  | exits 0 in ~100 ms      | **never exits**                | **never exits**        |
| black-holed (`10.255.255.1:6379`, SYN dropped) | **never exits**         | **never exits**                | **never exits**        |

On Bun 1.4.0, same three layers, same three servers - every cell exits:

| server      | plain `Bun.RedisClient` | `createBunRedisClient` | a bullmq `Queue`   |
| ----------- | ----------------------- | ---------------------- | ------------------ |
| healthy     | exits 0 in 6 ms         | exits 0 in 80 ms       | exits 0 in 82 ms   |
| refused     | exits 0 in 4 ms         | exits 1 in 83 ms       | exits 0 in 1079 ms |
| black-holed | exits 0 in 2006 ms      | exits 1 in 2086 ms     | exits 0 in 3082 ms |

The healthy row was always clean at every layer, which is why this never affected a
normal deployment. The `exits 1` cells are an unhandled rejection out of the adapter,
not a hang. **A green table here does not clear leak B** - the dunx app above still
hangs, so what this rules out is the raw snippets as reproductions, not the defect.

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

**Fixed in Bun 1.4.0: this exits 0 after 2008 ms, one `connectionTimeout` after the
attempt.** Measured on Bun 1.3.14, where none of these changed it: `maxRetries: 0`,
`autoReconnect: false`, `enableOfflineQueue: false` (which rejects in 10 ms without
waiting and still hangs, so it is the socket and not the command queue),
`connectionTimeout: 500`, calling `close()` twice, calling `close()` while the
connect is still pending, or waiting six seconds after `close()` before exiting.
`construct` and `close()` with no connect attempt is clean, and a **refused**
connection is clean - so the handle is the pending connect itself.

This is the same family as the two already in
[bun-apis.md](../../../docs/bun-apis.md) (subscriber mode, and a failed `subscribe`), and it
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

**On Bun 1.4 this snippet exits, and the defect is still there.** It survives one
reconnect attempt and stops; a `Queue`, which keeps more than one connection, does
not. Use the dunx app from the re-measurement section as the reproduction.

```ts
import { createBunRedisClient } from 'bullmq';
// Nothing listens on 6399. Hung on 1.3.14; exits in ~1081 ms on 1.4.0.
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
on Bun 1.3.14 and recorded in [bun-apis.md](../../../docs/bun-apis.md).

That covers **any** leaked handle, not just these two, which is why it is the right
layer: dunx cannot enumerate what a dependency leaks.

What it does not do is make the leaks go away. A forced exit skips whatever that
client would have done with a working connection, and it logs a line saying so.

## Options left

- **Leak A needs nothing: Bun 1.4 fixed it.** Do not file it.
- **Leak B is filed and needs nothing:**
  [taskforcesh/bullmq#4656](https://github.com/taskforcesh/bullmq/issues/4656), open,
  with the **dunx app** from the re-measurement above as the reproduction rather than
  the two-line snippet, which no longer hangs. Verified still open 2026-09-03.
- Re-measure on every Bun and bullmq bump, by natural exit rather than by `SIGTERM`.
  When leak B lands, the forced exit stops firing for this cause - the warning it
  logs is how you would notice.
