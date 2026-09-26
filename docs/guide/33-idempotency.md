# Idempotency

Mark a route `@Idempotent()` and a client retrying it with the same
`Idempotency-Key` gets the first response back instead of a second run.

```ts
import {
  Idempotent,
  IdempotencyModule,
  Post,
  RedisIdempotencyStore,
} from '@dunx/http';
import { RedisConnection } from '@dunx/infra/redis';

@Module({
  imports: [
    IdempotencyModule.forRootAsync({
      useFactory: (redis: RedisConnection, auth: AuthContext) => ({
        prefix: 'payments-api',
        store: new RedisIdempotencyStore(redis),
        subject: () => auth.current()?.user.id,
      }),
      inject: [RedisConnection, AuthContext] as const,
    }),
  ],
  controllers: [ChargesController],
})
export class PaymentsModule {}

@Controller('charges')
export class ChargesController {
  @Idempotent({ required: true })
  @Post('/', createCharge)
  create({ body }: Input<typeof createCharge>) {
    return this.charges.create(body);
  }
}
```

The behaviour follows
[draft-ietf-httpapi-idempotency-key-header-07](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/).

| Request                                                        | Answer                                                |
| -------------------------------------------------------------- | ----------------------------------------------------- |
| First with this key                                            | The handler runs, and its response is stored          |
| Same key, same method, path, query and body, after it finished | The stored response, plus `Idempotent-Replayed: true` |
| Same key, anything else different                              | 422                                                   |
| Same key while the first is still running                      | 409                                                   |
| No key, on a route with `required: true`                       | 400                                                   |
| No key, otherwise                                              | The handler runs; nothing is stored                   |
| A key that is not 1 to 255 visible ASCII characters            | 400                                                   |
| The store cannot be reached                                    | 503, and the handler does not run                     |
| `GET` or `HEAD`, on a controller marked `@Idempotent()`        | The handler runs; the guard does nothing              |

The 400, 409, 422 and 503 are thrown `HttpError`s, so they come out in the
app's error shape. The key may be sent bare or as a quoted Structured Field
String, as the draft writes it: `Idempotency-Key: "8e03978e-40d5-43e8-bc93-6894a57f9324"`.

## What is stored

| Handler outcome                                   | Stored | A retry          |
| ------------------------------------------------- | ------ | ---------------- |
| Returned a value or a `Response` below 500        | Yes    | Replays it       |
| Returned a 5xx `Response`                         | No     | Runs the handler |
| Threw, whatever the status                        | No     | Runs the handler |
| Body over `maxBodyBytes`                          | No     | Runs the handler |
| `@Sse()` route, or a `text/event-stream` response | No     | Runs the handler |

Stripe replays a 500. dunx releases the key instead, so the retry runs the
handler again. A handler that threw has usually rolled back its transaction, so
the retry is safe. A 4xx the handler returns, such as a declined payment, is
stored and replayed.

A replay carries the stored status, body and headers, except `Set-Cookie`,
and a cookie set through `req.cookies` is never stored
([Cookies](./35-cookies.md)).
Security headers, CORS and request logging sit outside the guard, so a replay
gets them the same as a first response. A `Bun.file` body over the cap is not
read to find that out. A `ReadableStream` body is read whole before its size
is known.

## The fingerprint

A SHA-256 of the method, the path with its query string, and the body bytes.
The same key on a different route is a different fingerprint, and a 422.

The guard reads the body before the handler does. On a route with a `body`
schema, the input reader then parses those bytes. On a route without one, the
guard reads a clone and leaves the request to the handler, at about 20 us for
the clone. Either way the whole body is held in memory to hash it, bounded by
`Bun.serve`'s `maxRequestBodySize`, 128 MiB unless the server sets another.

## Whose key it is

The stored key is `prefix`, the subject and the client's key. Two callers
sending the same key never see each other's response, as long as `subject`
tells them apart.

`subject` is required and has no default. `@dunx/http` cannot see a session,
so name the principal:

```ts
subject: () => auth.current()?.user.id,
```

An app with no auth writes `subject: () => undefined`, which puts every caller
in one key space: a caller who learns another's key and sends the same request
gets that caller's response. Omitting `subject` throws at boot.

`SessionGuard` must run before `subject` is called, because
`AuthContext.current()` has no user until then. You can put it in global
middleware or in the controller's `@UseGuards(SessionGuard)`. `@Idempotent()` on
a method runs after both.

## Options

| `IdempotencyModule` option | Default                  | Does                                                 |
| -------------------------- | ------------------------ | ---------------------------------------------------- |
| `prefix`                   | required                 | Namespaces every key. An empty one throws at boot    |
| `subject`                  | required                 | `(req, ctx) => string \| undefined`, the key's owner |
| `ttlSeconds`               | `86400`                  | How long a finished response is replayed             |
| `leaseSeconds`             | `60`                     | How long a running request holds its key             |
| `maxBodyBytes`             | `1048576`                | The largest response body stored                     |
| `store`                    | `MemoryIdempotencyStore` | Where keys live                                      |

Import `IdempotencyModule` wherever a module with an `@Idempotent()` controller
is booted, a test slice included. Without it, `listen()` fails naming the route:

```
Charges.create(): @Idempotent() needs IdempotencyModule.forRoot({ prefix, subject }) imported, and no module in this app imports it.
```

`@Idempotent()` takes `required` (default `false`) and `ttlSeconds`, which
overrides the module's. On a controller it covers every handler, and a
handler's own options win. `required` exists only on the decorator, so the
OpenAPI document, which reads route metadata, cannot disagree with the guard.

The lease frees a key after a crash. If the process that claimed a key dies, it
never completes or releases it, and a retry within `leaseSeconds` gets a 409.
Set the lease longer than your slowest handler, or a slow first request and its
retry can both run.

## OpenAPI

`@dunx/openapi` documents each `@Idempotent()` operation with an
`Idempotency-Key` header parameter, `required` as the decorator set it, typed as
a string of 1 to 255 visible ASCII characters. It adds the 409 and 422 responses,
and a 400 unless a declared schema already documents one. `GET` routes under a
controller-level decorator get neither.

## Stores

| Store                    | Shared between replicas | Notes                                              |
| ------------------------ | ----------------------- | -------------------------------------------------- |
| `MemoryIdempotencyStore` | No                      | The default. Holds 10,000 keys, then evicts oldest |
| `RedisIdempotencyStore`  | Yes                     | `SET NX PX` to claim, one `EVAL` each to finish    |

`RedisIdempotencyStore` takes anything with
`send(command: string, args: string[]): Promise<unknown>`, which `RedisConnection`
from `@dunx/infra/redis` and a bare `Bun.RedisClient` both have. The server must
allow `EVAL`.

A store of your own extends `IdempotencyStore` and implements `claim`, `read`,
`complete` and `release`. A throw from any of them is read as "unreachable".

## When the store is down

The guard answers 503 and does not run the handler, because running it without
a claim could charge a retry twice. `ThrottleGuard` behaves the other way and
lets requests through when its store is down.

A store that fails after the handler ran does not fail the request: the
response is returned, a warning is logged once per process, and the key stays
claimed until its lease runs out.

## Cost

A route without `@Idempotent()` pays nothing. For a route with it, measured with
`oha -c 64` against a route with a JSON body schema:

| Path                             | Added per request |
| -------------------------------- | ----------------- |
| First request, memory store      | 16 us             |
| Replay, memory store             | 8 us              |
| First request, Redis on loopback | 21 us             |
| Replay, Redis on loopback        | 16 us             |

Related: [Middleware and guards](./08-middleware-and-guards.md) for guard order,
[Resilience](./26-resilience.md) for retrying the calls an app makes, and
[Security](./32-security.md) for the headers a replay still gets.
