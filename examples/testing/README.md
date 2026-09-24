# @dunx/example-testing

How you test a dunx app. A small service with one external collaborator and one
guard, plus the two test files that exercise them.

```bash
bun install
bun run --filter '@dunx/example-testing' test
```

The app itself is thin: [`src/weather`](./src/weather) calls an
external forecast API, [`src/reports`](./src/reports) is behind an API-key guard.
Both exist to have something worth substituting.

| File                                                 | Shows                                                   |
| ---------------------------------------------------- | --------------------------------------------------------- |
| [`src/container.test.ts`](./src/container.test.ts)   | `createTestApp` - overrides, and `RecordingLogger`      |
| [`src/server.test.ts`](./src/server.test.ts)         | `createTestServer` - a real `Bun.serve`, and a guard    |

## The class is the seam

```ts
class FixedForecast extends ForecastClient {
  override async temperatureAt(): Promise<number> {
    return 31;
  }
}

const app = await createTestApp({
  modules: [WeatherModule],
  overrides: [provide(ForecastClient, { useValue: new FixedForecast() })],
});
```

dunx resolves by class, so binding a different class to the same token reaches
every consumer: no `IForecastClient`, no factory indirection, no mocking
framework needed. `bun test` already ships `mock()` and `spyOn()` if a single
method on a returned instance is all you need.

## Overrides replace; they never append

The container is scoped: every module reference is a scope holding its own
bindings, and one token can be bound in several of them. An override is not an
extra module tacked on the end that wins; it replaces the binding **in every
scope that holds it**, so a test stubbing a collaborator need not know how many
modules bind it. Three consequences:

- **The discarded provider is never constructed.** The replacement happens before
  anything resolves, so its constructor never runs, its `onInit` never fires, and
  overriding a database opens no connection. The test binds a class whose
  constructor throws and then overrides it; the suite passes.
- **An override naming a `token()` nobody binds is an error** rather than a silent
  no-op - the failure mode where a typo leaves you asserting against the real
  provider.
- **A class token nobody lists is not rejected.** A class self-binds, so an
  override for one is registered lazily and replaces that self-binding if
  anything asks for it.

`Logger` and `RequestContext` are overridable too, even though no module binds
them: core offers a default for each after every module, and the substitution
applies there as well.

## RecordingLogger

```ts
const logger = new RecordingLogger();
// ... provide(Logger, { useValue: logger })
expect(logger.at(LogLevel.ERROR).map((e) => e.message)).toEqual([
  'implausible reading for venus: 400',
]);
```

The `Logger` contract is seven levels of three overloads each, so every suite that
wants a quiet app would otherwise hand-write the same thirty lines. It records; it
does not interpret - no level filtering, no error promotion.

## A real server in place of a fake dispatcher

```ts
const server = await createTestServer({ modules: [WeatherModule], prefix: 'api' });
const { status, body } = await server.json<Reading>('api/weather/oslo');
await server.close();
```

Port 0, real `Bun.serve`, real sockets. A fake dispatcher could only exercise the
parts of the request path dunx wrote - not route matching, params, method dispatch
or upgrades, which are Bun's. Bun binds a socket in about a millisecond, so the
real server is cheaper than the lie.

Two differences from production, both intentional: `port` is always 0, and
**`requestLogging` defaults to `false`** so a suite does not print one JSON line
per assertion. Pass `requestLogging: true` to test the logging itself.

`json` on the init object is serialised and sets `content-type` for you, so one
option covers every verb:

```ts
await server.json('reports/7', { method: 'PATCH', json: { title: 'edited' } });
const raw = await server.request('avatars/7.png'); // the Response itself
```

## Testing a guard

Test it through the server rather than by calling `handle()`. What a guard reads -
`@Public()`, `@Roles()` - is route metadata that only exists once routes have been
discovered, so a direct call tests a different thing.

```ts
expect((await server.json('reports')).status).toBe(401);                       // no key
expect((await server.json('reports', { headers: { 'x-api-key': 'nope' } })).status).toBe(403);
expect((await server.json('reports/health')).status).toBe(200);                // @Public()
```

The guard's own dependency is overridden the same way anything else is - the suite
binds a key store with one known key.

## Websockets

Bun implements `WebSocket` natively, and wrapping it would add nothing, so
`@dunx/testing` ships no client of its own:

```ts
const ws = new WebSocket(`${server.url.replace('http', 'ws')}chat`);
```

[`examples/full/src/chat`](../full/src/chat) is a gateway with tests.

## Databases in tests

Not this package's surface. `@dunx/infra/db` binds an in-memory `bun:sqlite` with
the same driver as production, which is a better fixture than a mock -
[`examples/databases`](../databases) sets that up.
