# Upgrading

What changed, and the line that replaces each thing. Every item here is additive
except the first, which changes a default.

## An unmatched path answers 404

`HttpFactory.create` used to report a miss to global middleware with no route
metadata, so a global guard refused it and a prober could not tell a 404 from a 401. That is now opt-in.

| Before                            | After                                    |
| --------------------------------- | ---------------------------------------- |
| a miss behind a global guard: 401 | a miss behind a global guard: 404        |
| `notFound: 'public'` to get 404   | `notFound: 'guarded'` to get the old 401 |

An app with no global authentication guard needs no change and now behaves the way
every other framework does. An app that has one, and wants a miss to look like
every other refused request, sets it back:

```ts
await HttpFactory.create(AppModule, { notFound: 'guarded' });
```

## HTTP settings can come from validated config

`HttpFactory.create(root, options)` builds the container, so its `options` argument
has to be ready before any provider exists. An app whose request logging follows its
own configuration had to validate that configuration twice.

`HttpOptionsProvider` is a subclass resolved from the container:

```ts
export class AppHttpOptions extends HttpOptionsProvider {
  constructor(private readonly config: AppConfigService) {
    super();
  }

  override readonly trustProxy = true;

  override get prefix(): string {
    return this.config.get('prefix');
  }

  override get requestLogging(): RequestLoggingOptions {
    return { requestBody: this.config.get('log').requestBody };
  }
}

@Module({
  providers: [provide(HttpOptionsProvider, { useClass: AppHttpOptions })],
  exports: [HttpOptionsProvider],
})
export class HttpConfigModule {}
```

| Before                                           | After                            |
| ------------------------------------------------ | -------------------------------- |
| `const log = validate(Bun.env).log` in `main.ts` | inject `AppConfigService`        |
| `app.setGlobalPrefix('api')`                     | `override get prefix()`, or both |
| `app.enableCors({ ... })`                        | `override get cors()`, or both   |
| `app.set('trust proxy', true)`                   | `override readonly trustProxy`   |

**Nothing is removed.** `setGlobalPrefix`, `enableCors`, `set` and
`enableShutdownHooks` all still work, and a call to one wins over the provider,
because it happens after construction. An argument to `create()` wins too, field by
field, so a setting can move into the container one at a time.

Override a field with a field and a getter with a getter: TypeScript rejects the
other pairing with `TS2611` and `TS2610`. To derive a field from config, declare
`override trustProxy: boolean` and assign it in the constructor.

## A named outbound client can be a class

`httpClient(name)` returns a `Token`, and a token is not a class, so a named client
could only be reached with `inject()` in a field initialiser.

```ts
export class EmailClient extends HttpService {}

HttpModule.forRootAsync({ useFactory, inject }, EmailClient);
```

| Before                                         | After                                      |
| ---------------------------------------------- | ------------------------------------------ |
| `readonly email = inject(httpClient('email'))` | `constructor(private email: EmailClient)`  |
| `HttpModule.forRoot({ name: 'email', ... })`   | `HttpModule.forRoot({ ... }, EmailClient)` |

The string form still works. A subclass does not claim `HttpService`, so a default
client and any number of named ones coexist.

## A named Redis connection can be a class

The same change, in `@dunx/infra/redis`. `redisConnection(name)` returns a `Token`,
so a named connection could only be reached with `inject()` in a field.

```ts
export class SessionsRedis extends Redis {}

RedisModule.forRootAsync({ useFactory, inject }, SessionsRedis);
```

| Before                                                 | After                                         |
| ------------------------------------------------------ | --------------------------------------------- |
| `readonly redis = inject(redisConnection('sessions'))` | `constructor(private redis: SessionsRedis)`   |
| `RedisModule.forRoot({ name: 'sessions', ... })`       | `RedisModule.forRoot({ ... }, SessionsRedis)` |

`Redis` is now exported for this: `RedisConnection` is the abstract contract and
takes no options, so it cannot be the base a subclass extends. The string form
still works, and a subclass does not claim `RedisConnection`.

## The websocket relay can be a provider

`relay: new RedisRelay({...})` was an instance `main.ts` built and threaded into
`HttpFactory.create`, which made it the one setting an options provider could not
answer from config.

| Before                                     | After                                        |
| ------------------------------------------ | -------------------------------------------- |
| `new RedisRelay(...)` in `main.ts`         | `WsRelayModule.forRootAsync({ useFactory })` |
| `relay:` and `relayChannel:` on `create()` | `override get relay()` on the provider       |

The container closes it at shutdown, which `PubSub.close()` does not do for an app
that never opened a socket. Passing an instance to `create()` still works.

## A constraint violation answers 409

A unique violation reaching the HTTP layer used to answer 500.

```ts
try {
  return this.db.insert(users).values({ name }).returning().get();
} catch (error) {
  throw toDatabaseError(error);
}
```

`toDatabaseError` returns a `ConstraintError` carrying a status - 409 for a unique
or foreign key violation, 400 for not-null and check - and returns anything it does
not recognise untouched. `@dunx/http` reads the status off it, so no error filter is
involved. `transaction`, `transactionSync` and `runSeeds` already classify on the
way out.

The driver's own message stays on `cause` rather than in the response body, which
would otherwise carry the table and column names.

## Four more `fetch` options

`HttpClientOptionsInit` passes `compress`, `protocol` and `maxRedirects` through,
and `proxy` widens to `string | URL | { url, headers }` - the object form sends
`Proxy-Authorization` to the proxy rather than to the target.

`protocol: 'http2'` lets concurrent requests to one origin share a connection.
Against a cleartext `http://` upstream Bun raises `HTTP2Unsupported` rather than
falling back, so set it only against an HTTPS origin that offers h2.
