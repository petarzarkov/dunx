# @dunx/testing

The container an app already has, with named bindings **replaced in place**, plus
a real `Bun.serve` on port 0. Bun binds a socket in about a millisecond, so the
thing under test is the thing that ships: there is no mocking framework, no fake
request object and no in-memory transport.

## Install

```bash
bun add -d @dunx/testing
```

## Usage

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

## What is here

The [Testing guide](../../docs/guide/11-testing.md) is canonical.

| Export             | What it does                                                    |
| ------------------ | ---------------------------------------------------------------- |
| `createTestApp`    | The container, with overrides applied before anything resolves   |
| `createTestServer` | The same, behind a real `Bun.serve` on port 0                    |
| `testClient`       | The fetch-and-parse plumbing against a base url                  |

## Notes

- An override replaces the binding in **every scope that holds it**, so a test
  stubbing `Logger` need not know how many modules bind it. Naming a token
  nobody binds is an error rather than a silent no-op.
- The replacement happens before anything resolves, so the discarded provider is
  never constructed: its `useFactory` never runs and its `onInit` never fires,
  which makes overriding a database safe.
- Request logging and boot logging are off unless asked for.
- An `HttpOptions` field not passed is absent; nothing is inherited from
  production. `middleware` and `onError` change what the application does, so
  pass the same object `main.ts` passes.

## License

MIT
