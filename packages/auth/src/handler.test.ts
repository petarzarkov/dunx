import { Module } from '@dunx/core';
import { HttpFactory, type HttpApp } from '@dunx/http';
import { memoryAdapter } from 'better-auth/adapters/memory';
import { describe, expect, it } from 'bun:test';
import { SessionGuard } from './guard.js';
import { AuthModule } from './module.js';

/**
 * No tables and no schema: nothing here reaches the database. `/ok` is better-auth's
 * own liveness endpoint, which is enough to prove the mount resolved.
 */
interface Setup {
  readonly basePath: string;
  readonly mountAt?: string;
  readonly prefix?: string;
  /** Surfaces a thrown message, which the default 5xx mapper deliberately hides. */
  readonly reportErrors?: boolean;
}

const appWith = async (setup: Setup): Promise<HttpApp> => {
  @Module({
    imports: [
      AuthModule.forRoot(
        {
          secret: 'a-test-secret-of-at-least-32-characters',
          baseURL: 'http://localhost',
          basePath: setup.basePath,
          database: memoryAdapter({}),
        },
        setup.mountAt,
      ),
    ],
  })
  class Root {}

  const app = await HttpFactory.create(Root, {
    middleware: [SessionGuard],
    requestLogging: false,
    ...(setup.reportErrors === true
      ? {
          onError: (error: unknown) =>
            Response.json({ error: (error as Error).message }, { status: 500 }),
        }
      : {}),
  });
  if (setup.prefix !== undefined) app.setGlobalPrefix(setup.prefix);
  return app;
};

describe('AuthHandler', () => {
  it('serves better-auth under a plain basePath', async () => {
    const app = await appWith({ basePath: '/api/auth' });
    const base = (await app.listen(0)).replace(/\/$/, '');

    expect((await fetch(`${base}/api/auth/ok`)).status).toBe(200);
    // The wildcard claims nothing outside the mount. An unmatched path reaches the
    // fallback, where the global guard rejects it before the 404 — which is the
    // right answer, since a 404 there would enumerate the app's surface.
    expect((await fetch(`${base}/elsewhere`)).status).toBe(401);
    await app.shutdown();
  });

  it('mounts under a global prefix when told where the route goes', async () => {
    // The route is `/auth`; `setGlobalPrefix('api')` makes the pathname `/api/auth`,
    // which is the string better-auth was given.
    const app = await appWith({
      basePath: '/api/auth',
      mountAt: '/auth',
      prefix: 'api',
    });
    const base = (await app.listen(0)).replace(/\/$/, '');

    expect((await fetch(`${base}/api/auth/ok`)).status).toBe(200);
    await app.shutdown();
  });

  it('names the mismatch instead of letting better-auth answer 404', async () => {
    // Mounted at `/auth` with no prefix, so the pathname is `/auth/...` while
    // better-auth is looking for `/api/auth/...`.
    const app = await appWith({
      basePath: '/api/auth',
      mountAt: '/auth',
      reportErrors: true,
    });
    const base = (await app.listen(0)).replace(/\/$/, '');

    const response = await fetch(`${base}/auth/ok`);
    expect(response.status).toBe(500);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('better-auth is configured with basePath');
    await app.shutdown();
  });

  it('fails at boot when an async factory picks a basePath the mount cannot follow', async () => {
    @Module({
      imports: [
        AuthModule.forRootAsync({
          useFactory: () => ({
            secret: 'a-test-secret-of-at-least-32-characters',
            basePath: '/identity',
            database: memoryAdapter({}),
          }),
        }),
      ],
    })
    class Root {}

    const failed = await HttpFactory.create(Root, {
      requestLogging: false,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((failed as Error).message).toContain('/identity');
    expect((failed as Error).message).toContain('/api/auth');
  });

  it('answers every verb the mount declares', async () => {
    const app = await appWith({ basePath: '/api/auth' });
    const base = (await app.listen(0)).replace(/\/$/, '');

    // better-auth declares no PUT/PATCH/DELETE endpoints of its own, so its router —
    // not Bun's — is what answers. Reaching it at all is the assertion.
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const response = await fetch(`${base}/api/auth/ok`, { method });
      expect(response.status).not.toBe(405);
    }
    await app.shutdown();
  });
});
