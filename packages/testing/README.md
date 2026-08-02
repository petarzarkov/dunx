# @dunx/testing

The container an app already has, with named bindings **replaced in place**, plus a
real `Bun.serve` on port 0. No mocking framework, no fake request object, no
in-memory transport - Bun binds a socket in about a millisecond, so the thing under
test is the thing that ships.

```ts
import { provide } from '@dunx/core';
import { createTestApp, createTestServer } from '@dunx/testing';

// The container only.
const app = await createTestApp({
  modules: [UsersModule],
  overrides: [provide(Clock, { useValue: new FixedClock('2026-01-01') })],
});
expect(app.get(UsersService).today()).toBe('2026-01-01');
await app.shutdown();

// The container behind a real server.
const server = await createTestServer({
  modules: [ApiModule],
  overrides: [provide(Storage, { useClass: MemoryStorage })],
  prefix: 'api',
});
const { status, body } = await server.json<User[]>('api/users');
await server.close();
```

## Overrides replace; they never append

This is the whole design, and it follows from the container being flat.

`@dunx/core` collects every module's registrations into one list and **throws on a
duplicate token**, naming both modules. So a test override cannot be an extra
module appended at the end that wins - there is no "wins". It would be a duplicate.

`createTestApp` therefore assembles the same flat list the app would have and
substitutes by token as it goes. Three consequences worth relying on:

- **The count per token never changes.** The duplicate-binding check runs
  unmodified, so a test cannot paper over a wiring bug that boot would have caught.
  Two modules binding one token still fails, with the override applied to both.
- **An override naming a token nobody binds is an error**, not a silent no-op. A
  typo'd token would otherwise leave the suite asserting against the real provider
  it thought it had swapped, which is the failure mode this package exists to
  prevent.
- **The discarded provider is never instantiated.** Its `useFactory` never runs and
  its `onInit` never fires. Overriding the database does not open a connection to
  the real database - that is the one guarantee here that a hand-rolled fixture
  usually gets wrong, and `app.test.ts` proves it with a factory that throws if it
  is ever called.

`Logger` and `RequestContext` are overridable too, even though no module binds
them: core offers a default for each after every module, and the substitution
applies there as well.

## API

| Export                      | What it is                                                              |
| --------------------------- | ----------------------------------------------------------------------- |
| `createTestApp(options)`    | `Promise<App>` - the core container, overrides applied                  |
| `createTestServer(options)` | `Promise<TestServer>` - the same, plus `Bun.serve` on port 0 and a client |
| `testClient(url)`           | `TestClient` - the request helpers against any base URL                 |
| `testRoot(modules)`         | The synthetic root module, for driving `HttpFactory` yourself           |
| `RecordingLogger`           | A `Logger` that keeps entries instead of writing them                   |

`modules` takes one module ref or several; several become the `imports` of one
synthetic root, so no fixture module has to be written by hand. Anything a module
ref can be works - a class, or a `DynamicModule` from a `forRoot`.

`TestServer` is a `TestClient` plus `app` (the real `HttpApp`, for `app.get(...)`)
and `close()`. `createTestServer` passes `HttpOptions` through, with two
differences: `port` is always 0, and **`requestLogging` defaults to `false`** - it
is on by default in production for good reasons, none of which apply to a suite
that would otherwise print one JSON line per assertion. Pass
`requestLogging: true` to test the logging itself.

Everything else is **absent unless passed**, and `middleware` and `onError` decide
what the application is: forget them and the fixture has no global guards and the
default error mapper, and answers 200 where production answers 401. Export one
`httpOptions(config)` and spread it into both `main.ts` and every suite. Omitting
`middleware` in a graph that declares a `Middleware` no `@UseGuards` attaches warns
on `console.warn`; `middleware: []` says the omission is deliberate.

### The client

Two methods, because a third would be the start of an assertion DSL:

```ts
const { status, headers, body } = await server.json<Page>('notes?limit=10');
await server.json('notes/7', { method: 'PATCH', json: { title: 'edited' } });
const image = await server.request('avatars/7.png'); // the raw Response
```

`json` on the init object is serialized and sets `content-type: application/json`
unless `headers` already carries one - one option for every verb, rather than a
`post`/`put`/`patch` triple. `json()` reads the body as text before parsing, so a
route that answered 204, HTML or a plain-text error fails with the status,
content-type and body rather than with `JSON.parse`'s message.

### RecordingLogger

The `Logger` contract is seven levels of three overloads each, so every suite that
wants a quiet app would otherwise hand-write the same thirty lines:

```ts
const logger = new RecordingLogger();
await createTestApp({
  modules: [PaymentsModule],
  overrides: [provide(Logger, { useValue: logger })],
});
expect(logger.at(LogLevel.ERROR)).toEqual([]);
```

It records; it does not interpret. No level filtering, no error promotion, no
merging of extras - those are `@arkv/logger`'s behaviour, and asserting against a
reimplementation of them would prove nothing.

## Deliberately not here

- **A fluent assertion DSL** (`expect(res).toHaveStatus(200)`, supertest-style
  chaining). `status` and a parsed `body` read fine through `expect` already, and a
  matcher library would be a second vocabulary to learn for no new capability.
- **Provider spies / partial mocks.** `provide(Token, { useValue })` with a class
  the test wrote is smaller than any mocking API, and `bun test` already ships
  `mock()` and `spyOn()` for a method on an instance the container handed back.
- **A `providers` key on the options.** `{ modules, overrides }` is the shape, on
  purpose: a suite tests the modules an app actually ships. A fixture class that
  needs binding goes in a two-line `@Module`, which is also where it would live if
  it were real.
- **A fake HTTP dispatcher.** It could only exercise the parts of the request path
  dunx wrote, and not the parts Bun owns - route matching, params, method
  dispatch, upgrades. The real server is cheaper than the lie.
- **Database fixtures, transactional rollback, seeding.** That is drizzle's
  surface, not this package's. `@dunx/infra/db` binds an in-memory `bun:sqlite`
  with the same driver as production, which is a better fixture than a mock.
- **A websocket client.** Bun implements `WebSocket` natively, and a gateway test
  is `new WebSocket(server.url.replace('http', 'ws') + '/chat')`. Wrapping that
  would add nothing.

## Install it as a devDependency

```bash
bun add -d @dunx/testing
```

`@dunx/core` and `@dunx/http` are `dependencies`, at a **caret** range. What matters
is that your app and this package resolve to **one copy of `@dunx/core`** - two
copies means two `Logger` classes and two `RequestContext` classes, so tokens that
match nothing and overrides that silently replace nothing. A caret range hoists to
the copy your app already has.

Peers would have expressed that better, and were tried first: `bun run --filter '*'`
derives its build order from `dependencies` only, so a peer-only manifest cannot be
built in this monorepo at all. The reasoning and the measurement are in
[ARCHITECTURE.md](../../docs/ARCHITECTURE.md), "Test harness".
