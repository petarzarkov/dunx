# @dunx/testing

Test a dunx app against its real container and a real `Bun.serve`. Replace the
bindings you want to fake, and everything else runs as it does in production.
Starting a server on port 0 takes about a millisecond, so there is no mock
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

The [Testing guide](../../docs/guide/11-testing.md) covers each of these in full.

| Export                           | What it does                                                          |
| -------------------------------- | --------------------------------------------------------------------- |
| `createTestApp`                  | Boots the container, with your overrides applied first                |
| `createTestServer`, `TestServer` | The same, behind a real `Bun.serve` on port 0                         |
| `testClient`, `TestClient`       | `fetch` against a base URL, plus a JSON helper                        |
| `http2Client`, `Http2Client`     | The same over HTTP/2, for a server started with `http2: true`         |
| `RecordingLogger`                | A `Logger` that keeps every entry, so a test can assert on what it logged |
| `testRoot`                       | The root module `createTestApp` boots, for calling `HttpFactory.create` yourself |

## Notes

- An override replaces a binding in every module that binds it, so a test that
  fakes `Logger` does not need to know how many modules bind one. Overriding a
  token that nothing binds is an error. Overriding a class that nothing asks for
  is allowed and does nothing.
- Overrides are applied before anything is created, so the provider you replaced
  never runs: its `useFactory` is not called and its `onInit` does not fire. You
  can override a database without it connecting.
- Request logging and boot logging are off unless you turn them on.
- The health module's shutdown drain is set to `drainDelayMs: 0`, since a test
  has no load balancer waiting on it. An override of `ReadinessOptions` you pass
  yourself takes precedence.
- `HttpOptions` you do not pass are left unset; nothing is copied from
  production. Pass the same `middleware` and `onError` that `main.ts` passes, or
  the test server will not behave like your app. `createTestServer` warns when it
  finds guards in the graph that no middleware list attaches.

## License

MIT
