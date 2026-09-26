# Testing

`@dunx/testing` is centred on two functions and a logger, `createTestApp`,
`createTestServer` and `RecordingLogger`, with `testRoot`, `testClient` and
`http2Client` for the cases they do not cover. It builds the container your
application would have, with the bindings you name replaced, and it can put a
real `Bun.serve` in front of that container too.

```ts
import {
  createTestApp,
  createTestServer,
  RecordingLogger,
} from '@dunx/testing';
```

The runner is `bun test`. There is no separate test framework to install and
nothing to configure.

## `createTestApp`: the container, and nothing else

Use it when the thing under test is a service, which is most of the time.

```ts
import { describe, expect, test } from 'bun:test';
import { provide, token } from '@dunx/core';
import { createTestApp } from '@dunx/testing';

class FixedForecast extends ForecastClient {
  constructor(private readonly celsius: number) {
    super();
  }

  override async temperatureAt(): Promise<number> {
    return this.celsius;
  }
}

describe('createTestApp', () => {
  test('an override replaces the real collaborator everywhere', async () => {
    const app = await createTestApp({
      modules: [WeatherModule],
      overrides: [provide(ForecastClient, { useValue: new FixedForecast(31) })],
    });

    expect(await app.get(WeatherService).read('lisbon')).toEqual({
      city: 'lisbon',
      celsius: 31,
      advice: 'take water',
    });

    await app.shutdown();
  });
});
```

`modules` takes one module or several. dunx imports them into a root module for
you, so you do not write a test module by hand. You get back a normal `App` with
`get`, `shutdown`, `closed` and `enableShutdownHooks`. As in production, every
provider is created and `onInit` has run before the promise resolves.

The fake above is a plain subclass with an `override`, so it typechecks against
the real class. No mocking framework, interface or `jest.mock` is needed.

### Overrides replace in place

`AppFactory.create` builds the same module graph as in production, then replaces
the token **in every module that binds it**, before anything resolves. A test
that stubs `Logger` does not need to know how many modules bind it.

An override is not an extra module added at the end. Such a module would be a
separate scope that nothing already wired can see, so it would replace nothing.

You cannot aim an override at one module. If two modules bind a token
differently and you want only one of them, resolve through that module instead
of overriding.

The replaced provider is never built:

```ts
test('the discarded provider is never constructed', async () => {
  class Exploding extends ForecastClient {
    constructor() {
      super();
      throw new Error('the real client was constructed');
    }
  }

  @Module({
    providers: [
      provide(ForecastClient, { useClass: Exploding }),
      WeatherService,
    ],
  })
  class ExplodingWeather {}

  const app = await createTestApp({
    modules: [ExplodingWeather],
    overrides: [provide(ForecastClient, { useValue: new FixedForecast(5) })],
  });

  expect((await app.get(WeatherService).read('oslo')).celsius).toBe(5);
  await app.shutdown();
});
```

The replacement happens before anything resolves, so the discarded provider's
constructor, `useFactory` and `onInit` never run. A real database provider that
you override never opens a connection.

Overrides are part of `@dunx/core`, as `AppFactory.create(root, { overrides })`,
so you can also use them outside tests, for example for a deployment variant.
`HttpOptions extends AppOptions`, so `HttpFactory.create` accepts them too.

### An unmatched override is an error - unless it is a class

```ts
test('an override naming a token nobody binds is an error', async () => {
  const Clock = token<Date>('Clock');

  const message = await createTestApp({
    modules: [WeatherModule],
    overrides: [provide(Clock, { useValue: new Date(0) })],
  }).then(
    () => 'it resolved',
    (error: unknown) => (error as Error).message,
  );

  expect(message).toContain('Nothing to override for Clock');
});
```

The full message:

> Nothing to override for Clock: no module in the graph binds it, **and it is not a
> class, so nothing self-binds it either**. An override replaces a binding - it
> cannot add one, because a token nobody bound is a token nothing under test
> resolves.

Without this error, a suite would test the real provider while believing it had
replaced it, and still pass. The error names **every** unmatched token, not just
the first.

**A class is not checked.** Any class can be injected without being listed, so an
override for a class replaces the binding it would get when first asked for.
dunx registers that override lazily, so a stub is not built for a class the test
never uses.

As a result, **an override for the wrong class is accepted silently**: nothing
fails to match, nothing asks for it, and it never takes effect. Measured:

```
override a declared class      -> resolves, replacement used
override a class nobody binds  -> resolves, no error
override a token() nobody binds -> throws "Nothing to override"
```

Only `token()` overrides are checked. If a class override seems to do nothing,
check that the test imports the same class the module uses. Two copies of a
package mean two different class objects.

The usual cause of the "Nothing to override" error is a token whose module you
forgot to list in `modules`. The second most common is a second copy of `@dunx/core` in the
dependency tree: a second copy is a second `Logger` class and therefore a token
that matches nothing.

### Overriding a contract no module bound

`Logger` and `RequestContext` are the two tokens `@dunx/core` guarantees are
resolvable. They are offered by `registerDefault` **after** every module, so in a
typical app nothing in the module graph binds them at all, and an override of
`Logger` would have been "nothing to override".

The defaults are built as a `Registration[]` and run through the same
substitution, so the logger can be silenced:

```ts
test('RecordingLogger keeps entries instead of writing them', async () => {
  const logger = new RecordingLogger();
  const app = await createTestApp({
    modules: [WeatherModule],
    overrides: [
      provide(ForecastClient, { useValue: new FixedForecast(400) }),
      provide(Logger, { useValue: logger }),
    ],
  });

  await app.get(WeatherService).read('venus');

  expect(logger.at(LogLevel.ERROR).map((entry) => entry.message)).toEqual([
    'implausible reading for venus: 400',
  ]);
  await app.shutdown();
});
```

Overriding one default leaves the other alone: `RequestContext` is still core's.
The unmatched-override check runs after module bindings and defaults are both in
place, so overriding a token that only a default provides does not fail.

## `RecordingLogger`

A `Logger` that keeps entries instead of writing them, so a suite can assert on
what was logged and stays quiet when it does not care.

| Member      | Does                                            |
| ----------- | ----------------------------------------------- |
| `entries`   | `{ level, message, params }[]`, in order.       |
| `at(level)` | Filters by `LogLevel`.                          |
| `clear()`   | Empties `entries`.                              |
| `logLevel`  | `LogLevel.VERBOSE`, so nothing is filtered out. |

The `Logger` contract is seven levels with three overloads each, so this saves
writing the same thirty lines in every suite.

It **interprets nothing**: no level filtering, no error promotion, no merging of
extras. Those are the backing logger's behaviour, and asserting against a
reimplementation of them would prove nothing about the logger you actually ship.
The one exception is `log()`, which records as `info` per the contract.

## `createTestServer`: a real server on port 0

```ts
import { describe, expect, test } from 'bun:test';
import { provide } from '@dunx/core';
import { createTestServer } from '@dunx/testing';

test('validates, routes and serialises through the real server', async () => {
  const server = await createTestServer({
    modules: [WeatherModule],
    overrides: [provide(ForecastClient, { useValue: new FixedForecast() })],
    prefix: 'api',
  });

  const { status, body } = await server.json<{ advice: string }>(
    'api/weather/oslo',
  );

  expect(status).toBe(200);
  expect(body.advice).toBe('take a coat');
  await server.close();
});
```

`TestServerOptions` is `TestAppOptions` plus every `HttpOptions` field except
`port` and `overrides`, so `middleware`, `onError`, `websocket` and the rest are
all available. `prefix` applies `setGlobalPrefix` before `listen()`, so the
client's URLs carry it.

### Pass the same `HttpOptions` production passes

Every one of those fields is **absent unless you pass it**, and two of them
decide what the application _is_: `middleware` holds the global guards, `onError`
the error mapper.

A suite that forgets them gets a server with no global guards and the default
mapper. It boots fine and answers 200 where production answers 401. That fixture
is quietly testing a different application.

So define the options once, export them, and give the same function to `main.ts`
and to every suite:

```ts
// src/http-options.ts
export const httpOptions = (config: AppConfig): HttpOptions => ({
  middleware: [ApiKeyGuard, RateLimit],
  onError: mapDomainErrors,
  requestLogging: { ignore: ['/health'], correlateIgnored: true },
  port: config.PORT,
});
```

```ts
// main.ts
const app = await HttpFactory.create(AppModule, httpOptions(config));
```

```ts
// any suite
const server = await createTestServer({
  modules: [ApiModule],
  ...httpOptions(config),
  requestLogging: false,
});
```

`createTestServer` always overrides `port` (to `0`). `requestLogging` and
`bootLogging` are only **defaulted** to `false`: a value the spread carries wins,
so the shared object above would log every request in every suite unless the
call site sets `requestLogging: false` after the spread, as shown.

The alternative to spreading is to put the settings in an `HttpOptionsProvider`
the application's module binds (see
[Configuration](./12-configuration.md#settings-the-http-server-owns)). The suite
then imports that module and passes nothing.

**You get a warning if you forget.** Suppose the graph declares a `Middleware`
class that no `@UseGuards` attaches, which is how a global guard looks. If neither
the `middleware` argument nor a bound `HttpOptionsProvider` supplies middleware,
`createTestServer` writes one line to `console.warn` naming the class.

Bind the same `HttpOptionsProvider`
the application binds, or pass `middleware: []` to declare the omission
intentional, and the warning goes away.

It writes to `console.warn` rather than the bound `Logger` so that a suite
asserting on a `RecordingLogger` does not find an entry the application never
wrote.

`TestServer` is a `TestClient` plus three things:

| Member                  | Does                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| `url`                   | The base URL, as `listen()` returned it.                                         |
| `request(path?, init?)` | The raw `Response`. For bytes, HTML, or a header assertion.                      |
| `json<T>(path?, init?)` | `{ status, headers, body }` in one await.                                        |
| `app`                   | The `HttpApp`, for `app.get(...)` on anything in the container.                  |
| `gatewayUrl`            | Where gateways answer when `gatewayPort` split them off `url`; else `undefined`. |
| `close()`               | `app.shutdown()`: stops the server, then tears the container down.               |

`json:` on the init object serialises a body and sets `content-type:
application/json` unless the headers already carry one. It covers every verb, so
there is no `post`/`put`/`patch` triple to remember:

```ts
const { status, body } = await server.json('echo', {
  method: 'POST',
  json: { id: 7 },
});
```

### Why a real server rather than a mocked HTTP layer

Because **the routing under test is Bun's.**

dunx writes no JavaScript router. `Bun.serve({ routes })` does the path matching,
the `:param` extraction, the per-method dispatch and the method-miss 404.

A fake dispatcher would test only the parts of the request path dunx wrote, and
would guess at the rest. A test that passes against a fake can still fail
against Bun.

The specific things only a real server proves:

- `/weather/:city` matched, and `req.params.city` populated by Bun.
- A method miss is Bun's 404 and not a 405.
- The unmatched-path fallback runs, and answers
  `{"error":"NOT_FOUND","status":404}` rather than Bun's default body.
- An upgrade actually upgrades, which no fake `Request` can do.
- Header casing, `content-type` negotiation and body streaming behave as the
  runtime behaves.

And the objection does not hold up on cost: `Bun.serve` binds in about a
millisecond. **Port 0** means the OS picks a free port, so a suite can run in
parallel with a `bun start` already holding 3000 and with other suites.

```ts
test('an unmatched path is a JSON 404, not Bun’s default', async () => {
  const server = await createTestServer({ modules: [WeatherModule] });

  const { status, body } = await server.json<{ error: string }>('nope');

  expect(status).toBe(404);
  expect(body.error).toBe('NOT_FOUND');
  await server.close();
});
```

### Request logging is off here, and only here

`createTestServer` defaults `requestLogging` to `false`. The framework default
stays on, because one structured entry per request is right in production and pure
noise in a suite that would print a JSON line per assertion.

Asking for it is asking for it:

```ts
const logger = new RecordingLogger();
const server = await createTestServer({
  modules: [ApiModule],
  overrides: [provide(Logger, { useValue: logger })],
  requestLogging: true,
});
```

## Testing a guard through the real request path

A guard is worth testing through the server rather than by calling
`guard.handle()` directly. What it reads is route metadata that only exists once
routes have been discovered: `ctx.get(PUBLIC)` has no meaning outside a built
route table, and a hand-constructed `RouteContext` would be testing your
construction of it rather than the guard.

```ts
class KnownKeys extends ApiKeys {
  override accepts(presented: string): boolean {
    return presented === 'good-key';
  }
}

const withKnownKeys = () =>
  createTestServer({
    modules: [ReportsModule],
    overrides: [provide(ApiKeys, { useClass: KnownKeys })],
  });

test('401 with no key, 403 with a bad one, 200 with a good one', async () => {
  const server = await withKnownKeys();

  expect((await server.json('reports')).status).toBe(401);
  expect(
    (await server.json('reports', { headers: { 'x-api-key': 'nope' } })).status,
  ).toBe(403);

  const ok = await server.json<readonly string[]>('reports', {
    headers: { 'x-api-key': 'good-key' },
  });
  expect(ok.status).toBe(200);
  expect(ok.body).toEqual(['q1-revenue', 'q2-revenue']);

  await server.close();
});

test('@Public() opts a route out of the guard', async () => {
  const server = await withKnownKeys();

  expect((await server.json('reports/health')).status).toBe(200);

  await server.close();
});
```

The guard has dependencies like anything else, which makes it worth a test: the
key store is injected, so the suite binds a known set of keys instead
of reaching for the real one. The guard resolves from the container, so the
override reaches it with no special handling.

Guards are covered in [Middleware and guards](./08-middleware-and-guards.md).

## Configuration the harness does not cover

`createTestServer` calls `listen()` for you, which means `enableCors`, `use` and
`set` have already missed their window. When a test needs one of them, drop to the
factory. `testRoot` is exported for exactly that:

```ts
import { testRoot } from '@dunx/testing';
import { HttpFactory } from '@dunx/http';

const app = await HttpFactory.create(testRoot([ApiModule]), {
  requestLogging: false,
});
app.enableCors({ origin: 'https://example.test', credentials: true });
const url = await app.listen(0);
```

`testClient(url)` is exported too, so the same `request`/`json` pair can be
pointed at an app booted any other way.

`http2Client(url, timeoutMs?)` is the same pair over HTTP/2 cleartext, for a
server started with `http2: true`. Bun's `fetch` cannot call an h2c origin, so it
goes through `node:http2` with one connection per call. It takes a string, bytes
or `json` as the body and throws on anything else.

## `{ modules, overrides }`, and nothing more

A fixture class that needs binding goes in a two-line `@Module`, exactly where
it would live if it were real:

```ts
@Module({
  providers: [provide(Clock, { useValue: new FixedClock('2026-01-01') })],
})
class FixedTime {}

const app = await createTestApp({ modules: [BillingModule, FixedTime] });
```

The harness has no `providers` option; use a module like this instead. A
`providers` list would let a suite build a container the production app never
builds.

## Sharp edges

- **`json()` throws on a response that is not JSON**, and says so usefully: it
  reads the body as text first, so a 204, an HTML error page or a plain-text body
  fails with the status and the content type rather than with `JSON.parse`'s
  message. Use `request()` for anything that is not JSON.
- **Always `close()`.** A `Bun.serve` left listening keeps the test process alive.
  `afterAll(() => server.close())` is the usual shape when a suite shares one
  server.
- **`createTestApp` needs `shutdown()` too** if any provider implements
  `onShutdown`, or holds a connection.
- **Overrides are keyed by token identity** rather than by name. Two classes
  called `Clock` are two tokens.
- **The harness is not an assertion DSL** and will not become one. `json()`
  returns values that `expect` already reads well, so a failure points at your
  assertion rather than at a matcher this package would have had to define.
- **`prefix` accepts `string | undefined`** where the other options do not, so a
  suite that runs one fixture prefixed and unprefixed can pass a variable without
  a conditional spread at the call site.
- **An omitted `HttpOptions` field is absent** rather than defaulted to whatever
  production uses. `middleware` and `onError` are the two that change what the app
  does; bind the application's `HttpOptionsProvider` in the graph under test, or
  share one `httpOptions(config)` between `main.ts` and the suites.

This is the last of the core guides. `examples/testing` is a working version of
everything above, and `examples/full/src/service.test.ts` exercises the harness
against the full application.
