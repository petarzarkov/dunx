# Testing

`@dunx/testing` is two functions and a logger. It builds the container your
application would have, with the bindings you name replaced, and optionally binds
a real `Bun.serve` in front of it.

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

`modules` takes one module ref or several; they become the `imports` of one
synthetic root, so no fixture module has to be written by hand. What comes back is
a plain `App`: `get`, `shutdown`, `closed`, `enableShutdownHooks`. Providers are
resolved eagerly and `onInit` has already run by the time the promise settles,
exactly as in production.

The fake above is a class the test wrote. There is no mocking framework, no
interface, and no `jest.mock`. A subclass with an `override` is enough, and it
typechecks against the real thing, which a hand-built object literal would not.

### Overrides replace in place

This is the part worth understanding, because it is what makes the harness safe.

An override is **not** an extra module appended at the end that wins. A module
appended at the end would be its own scope, invisible to everything already wired,
so it would win nothing. Instead, `AppFactory.create` builds the scope graph it
always does and substitutes by token **in every scope that binds it**, before
anything resolves.

Every scope, so a test that stubs `Logger` never has to know how many modules
bind it; making it name a scope would push container topology into every suite.
Where two scopes genuinely bind a token differently and only one is meant,
resolve through the module that matters instead of overriding.

The consequence that matters:

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

Because the replacement happens before anything resolves, the discarded provider's
constructor never runs, its `useFactory` never runs, and its `onInit` never fires.
That is the guarantee a hand-rolled fixture usually misses: with an "append and
win" model, the real database provider is still in the list, still gets
instantiated, and still opens a connection that nothing under test uses.

The seam lives in `@dunx/core` as `AppFactory.create(root, { overrides })` rather
than in the testing package, and it is not a test-shaped API. It says "compose
this graph with these bindings replaced", which is also how a deployment variant
would be expressed. `HttpOptions extends AppOptions`, so
`HttpFactory.create` inherits it without a second mechanism.

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

The full message, and the second clause is the important one:

> Nothing to override for Clock: no module in the graph binds it, **and it is not a
> class, so nothing self-binds it either**. An override replaces a binding - it
> cannot add one, because a token nobody bound is a token nothing under test
> resolves.

A silent no-op here is the worst possible failure, because it leaves a suite
asserting against the real provider it believed it had swapped, and it passes. The
check names **every** unmatched token rather than the first, so a renamed token does
not turn into three rounds of the same error.

**A class is deliberately exempt, and that is a real gap in the safety net.** A class
self-binds: it needs no declaration to be resolvable, so an override for one is
replacing the binding that _would_ have happened on demand, and registering it
eagerly would construct a stub for a collaborator the graph under test never reaches.
That is why `Injector.registerLazy` exists.

The cost is that a **typo'd class override is accepted in silence** - there is no
binding for it to fail to match, and nothing under test asks for it, so it simply
never fires. Measured:

```
override a declared class      -> resolves, replacement used
override a class nobody binds  -> resolves, no error
override a token() nobody binds -> throws "Nothing to override"
```

So the check protects `token()` bindings and cannot protect class ones. If a class
override appears not to work, the first thing to suspect is the class itself: two
copies of a package means two class objects, and the one you imported in the suite is
not the one the module bound.

The most common way to hit it is a token whose module you forgot to list in
`modules`. The second most common is a second copy of `@dunx/core` in the
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

Overriding one default does not disturb the other: `RequestContext` is still
core's. The unmatched-override check runs after both stages, module bindings and
defaults, so it never fires spuriously on a token only the defaults provide.

## `RecordingLogger`

A `Logger` that keeps entries instead of writing them, so a suite can assert on
what was logged and stays quiet when it does not care.

| Member      | Does                                            |
| ----------- | ----------------------------------------------- |
| `entries`   | `{ level, message, params }[]`, in order.       |
| `at(level)` | Filters by `LogLevel`.                          |
| `clear()`   | Empties `entries`.                              |
| `logLevel`  | `LogLevel.VERBOSE`, so nothing is filtered out. |

It exists because the `Logger` contract is seven levels of three overloads each,
and every suite that wanted a silent logger would otherwise hand-write the same
thirty lines.

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
mapper. It boots fine and answers 200 where production answers 401, which is a
fixture quietly testing a different application.

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
});
```

`createTestServer` overrides `port` and `requestLogging` itself, so spreading the
whole object is safe.

**Forgetting is loud.** If the graph declares a `Middleware` implementation that no
`@UseGuards` attaches - the shape of a global guard - and no `middleware` was
passed, `createTestServer` writes one line to `console.warn` naming the class.
Pass `middleware: []` to declare the omission intentional and the warning goes
away.

It writes to `console.warn` rather than the bound `Logger` so that a suite
asserting on a `RecordingLogger` does not find an entry the application never
wrote.

`TestServer` is a `TestClient` plus two things:

| Member                  | Does                                                               |
| ----------------------- | ------------------------------------------------------------------ |
| `url`                   | The base URL, as `listen()` returned it.                           |
| `request(path?, init?)` | The raw `Response`. For bytes, HTML, or a header assertion.        |
| `json<T>(path?, init?)` | `{ status, headers, body }` in one await.                          |
| `app`                   | The `HttpApp`, for `app.get(...)` on anything in the container.    |
| `close()`               | `app.shutdown()`: stops the server, then tears the container down. |

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

A fake dispatcher could only exercise the parts of the request path dunx wrote,
and would silently agree with itself about the rest. A test that passes against a
fake and fails against Bun has taught you nothing except that the fake is
wrong.

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
`guard.handle()` directly, because what it reads is route metadata that only
exists once routes have been discovered. `ctx.get(PUBLIC)` has no meaning outside
a built route table, and a hand-constructed `RouteContext` would be testing your
construction of it.

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

## There is no `providers` option

`{ modules, overrides }` is the documented shape and stays that shape.

A `providers` list would let the harness assemble graphs that do not exist in the
application, which is how a suite ends up asserting against a container the
production app never builds. A fixture class that needs binding goes in a two-line
`@Module`, where it would live if it were real:

```ts
@Module({
  providers: [provide(Clock, { useValue: new FixedClock('2026-01-01') })],
})
class FixedTime {}

const app = await createTestApp({ modules: [BillingModule, FixedTime] });
```

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
  does; share one `httpOptions(config)` between `main.ts` and the suites.

This is the last of the core guides. `examples/testing` is a working version of
everything above, and `examples/full/src/service.test.ts` exercises the harness
against the full application.
