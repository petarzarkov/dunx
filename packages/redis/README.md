# @dunx/redis

Redis/Valkey for dunx, on `Bun.RedisClient`. No `ioredis`, no `redis`, no
dependency at all beyond `@dunx/core`.

```ts
import { RedisConnection } from '@dunx/redis';

export class SessionsService {
  constructor(private readonly redis: RedisConnection) {}

  async touch(id: string): Promise<void> {
    await this.redis.set(`session:${id}`, Date.now(), { ex: 3600 });
  }
}
```

`RedisConnection` is an `abstract class`, not an interface — the container resolves
constructor parameters by their runtime type, and an interface leaves nothing behind
to resolve. See `docs/ARCHITECTURE.md`.

## Setup

```ts
import { AppFactory, Module } from '@dunx/core';
import { RedisModule } from '@dunx/redis';

@Module({
  imports: [RedisModule.forRoot({ url: 'redis://localhost:6379' })],
  providers: [SessionsService],
})
class AppModule {}

const app = (await AppFactory.create(AppModule)).enableShutdownHooks();
```

`forRoot()` binds `RedisConnection` and `RedisOptions`. With no `url` it follows
Bun's own chain: `$VALKEY_URL`, then `$REDIS_URL`, then `valkey://localhost:6379`.

Configuration that has to be fetched goes through `forRootAsync`:

```ts
RedisModule.forRootAsync(async () => ({ url: await secrets.get('REDIS_URL') }));
```

There is no separate async machinery — the container resolves eagerly and awaits
factories before any constructor runs, so this is `forRoot` with a `useFactory`.

### Options

| Option                 | Default                  | Notes                                     |
| ---------------------- | ------------------------ | ----------------------------------------- |
| `url`                  | `$VALKEY_URL` → `$REDIS_URL` → `valkey://localhost:6379` | Validated when the module is configured |
| `name`                 | —                        | Binds `redisConnection(name)` instead     |
| `eager`                | `false`                  | Connect and `PING` during `onInit`        |
| `connectionTimeout`    | `10000`                  |                                           |
| `idleTimeout`          | `0`                      |                                           |
| `autoReconnect`        | `true`                   |                                           |
| `maxRetries`           | `10`                     |                                           |
| `enableOfflineQueue`   | `true`                   |                                           |
| `enableAutoPipelining` | `true`                   |                                           |
| `tls`                  | —                        | `boolean` or `Bun.TLSOptions`             |

Connections are lazy: nothing is dialled until the first command, so an
unavailable cache does not stop the process from booting. Set `eager: true` when
you would rather find out at startup. `onShutdown` closes the socket, so
`enableShutdownHooks()` is all the cleanup there is.

## Named connections

```ts
@Module({
  imports: [
    RedisModule.forRoot({ url: cacheUrl }),
    RedisModule.forRoot({ url: jobsUrl, name: 'jobs' }),
  ],
})
class AppModule {}
```

A named registration binds `redisConnection('jobs')` and deliberately does *not*
also claim `RedisConnection`, so any number of them can coexist with one default.
Because a token is not a constructor type, reach a named connection with `inject()`
rather than a constructor parameter:

```ts
import { inject } from '@dunx/core';
import { redisConnection } from '@dunx/redis';

export class JobQueue {
  private readonly redis = inject(redisConnection('jobs'));
}
```

`redisConnection(name)` is memoised, so the same name always yields the same token.

## Commands

The surface is a curated subset of the ~250 methods on `Bun.RedisClient`: strings
(`get`, `set`, `getdel`, `append`, `strlen`), keys (`del`, `exists`, `type`, `keys`,
`scan`, `rename`), counters (`incr`, `incrby`, `decr`, `decrby`), expiry (`expire`,
`pexpire`, `ttl`, `pttl`, `persist`), bulk (`mget`, `mset`), hashes (`hget`, `hset`,
`hmget`, `hgetall`, `hdel`, `hexists`, `hkeys`, `hvals`, `hlen`, `hincrby`), lists
(`lpush`, `rpush`, `lpop`, `rpop`, `lrange`, `llen`, `lindex`, `lrem`, `ltrim`),
sets (`sadd`, `srem`, `smembers`, `sismember`, `scard`), and pub/sub (`publish`,
`subscribe`, `unsubscribe`).

`SET` takes an options object instead of Bun's positional overloads:

```ts
await redis.set(key, value, { ex: 60, nx: true }); // null when the key existed
await redis.set(key, value, { get: true }); // the previous value
```

Anything not wrapped is one `send()` away, typed `unknown` rather than Bun's `any`:

```ts
const count = (await redis.send('EXISTS', ['a', 'b'])) as number;
await redis.send('ZADD', ['leaderboard', 1, 'ada']);
```

## Errors

Every failure is a `RedisError extends AppError`, carrying the failing command and
Bun's `code`:

```ts
import { isConnectionError, RedisError, RedisErrorCode } from '@dunx/redis';

try {
  await redis.get(key);
} catch (error) {
  if (isConnectionError(error)) return fallback;
  throw error;
}
```

Bun raises some of these **synchronously** — a data command issued while the
connection is in subscriber mode throws rather than rejecting — so the wrapper
catches around the call, not just the await, and you only ever see a rejection.

`RedisErrorCode.INVALID_RESPONSE` is the counter-intuitive one: Bun uses it for
errors the *server* returned, so `WRONGTYPE` and `ERR unknown command` both arrive
under it. The response parsed fine; the command was wrong.

## Pub/sub

`subscribe()` opens a **second connection**, lazily, on first use:

```ts
await redis.subscribe('events', (message, channel) => {
  console.log(channel, message);
});
await redis.set('still', 'works'); // fine — different socket
```

This is not an optimisation. A `Bun.RedisClient` in subscriber mode rejects every
data command with `ERR_REDIS_INVALID_STATE`, so sharing one socket would mean a
single `subscribe()` call silently broke every `get` and `set` in the process.
`unsubscribe(channel)` drops all listeners on it, `unsubscribe(channel, listener)`
just the one.

## Limitations

Found by probing Bun 1.3.14, not from its docs:

- **`PSUBSCRIBE` is unusable.** `Bun.RedisClient.prototype.psubscribe` exists and is
  absent from `bun-types`. Passing a listener throws `ERR_INVALID_ARG_TYPE`
  (it accepts only strings and buffers), and passing patterns alone returns a
  promise that **never settles**. There is no pattern subscription here as a result,
  and `send('PSUBSCRIBE', …)` will not help — the reply has nowhere to be delivered.
- **`exists()` is single-key.** Bun coerces Redis's integer reply to a boolean, so a
  multi-key call cannot tell "one of three" from "three of three". Use
  `send('EXISTS', keys)` for a count.
- **`enableOfflineQueue: false` needs an explicit connect.** With no queue to hold
  the first command during the handshake, a lazily issued one is rejected with
  `Connection is closed and offline queue is disabled` even against a healthy
  server. Pair it with `eager: true`, which connects before it pings.
- **Bun accepts an unparseable URL** and only fails later, at connect time, as an
  opaque `Connection closed`. `RedisOptions` validates the URL and its protocol
  while the module is being configured instead.
- `psubscribe`, `punsubscribe`, `pubsub`, `script`, and `select` are all on the
  prototype but missing from `bun-types`. Of those, `pubsub`, `script`, and `select`
  do work — reach them through `send()`.
- Buffer-valued subscriptions are not implemented by Bun; listeners get strings.
- Transactions (`MULTI`/`EXEC`) and Lua (`EVAL`) have no wrapper. `send()` works for
  `EVAL`; `MULTI` needs command-ordering guarantees that `enableAutoPipelining`
  makes unsafe to assume.

## Testing without a server

The integration suite probes the server first and skips itself when nothing
answers, so `bun test` passes on a machine with no Redis. Unit coverage of option
handling, module wiring, error mapping, and lifecycle needs no server at all —
`Bun.RedisClient` connects lazily, so a container can be built and torn down
against an address that is never dialled.
