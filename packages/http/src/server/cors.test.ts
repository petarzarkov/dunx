import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import { Controller, Get, Post } from '../route/decorators.js';
import { HttpFactory, type HttpApp } from './factory.js';
import type { Middleware } from './middleware.js';

@Controller('users')
class UsersController {
  @Get('/')
  list(): string[] {
    return ['ada'];
  }

  @Post('/')
  create(): { created: true } {
    return { created: true };
  }
}

@Module({ controllers: [UsersController] })
class AppModule {}

const withApp = async (
  configure: (app: HttpApp) => void,
  run: (url: string) => Promise<void>,
): Promise<void> => {
  const app = await HttpFactory.create(AppModule);
  configure(app);
  const url = await app.listen(0);
  try {
    await run(url);
  } finally {
    await app.shutdown();
  }
};

const allowOrigin = (response: Response): string | null =>
  response.headers.get('access-control-allow-origin');

describe('enableCors()', () => {
  it('answers a real preflight and echoes an allowed origin', async () => {
    await withApp(
      (app) => {
        app.enableCors({
          origin: 'https://example.com',
          credentials: true,
          allowedHeaders: ['content-type', 'authorization'],
          exposedHeaders: ['x-total'],
          maxAge: 600,
        });
      },
      async (url) => {
        const preflight = await fetch(new URL('users', url), {
          method: 'OPTIONS',
          headers: {
            origin: 'https://example.com',
            'access-control-request-method': 'POST',
          },
        });

        expect(preflight.status).toBe(204);
        expect(allowOrigin(preflight)).toBe('https://example.com');
        expect(
          preflight.headers
            .get('access-control-allow-methods')
            ?.split(', ')
            .sort(),
        ).toEqual(['GET', 'POST']);
        expect(preflight.headers.get('access-control-allow-headers')).toBe(
          'content-type, authorization',
        );
        expect(preflight.headers.get('access-control-max-age')).toBe('600');
        expect(preflight.headers.get('access-control-allow-credentials')).toBe(
          'true',
        );
        expect(preflight.headers.get('vary')).toContain('Origin');

        const actual = await fetch(new URL('users', url), {
          headers: { origin: 'https://example.com' },
        });
        expect(allowOrigin(actual)).toBe('https://example.com');
        expect(actual.headers.get('access-control-expose-headers')).toBe(
          'x-total',
        );
      },
    );
  });

  it('gives a disallowed origin no CORS headers at all', async () => {
    await withApp(
      (app) => {
        app.enableCors({ origin: 'https://example.com' });
      },
      async (url) => {
        const preflight = await fetch(new URL('users', url), {
          method: 'OPTIONS',
          headers: { origin: 'https://evil.test' },
        });
        expect(preflight.status).toBe(204);
        expect(allowOrigin(preflight)).toBeNull();
        expect(
          preflight.headers.get('access-control-allow-methods'),
        ).toBeNull();

        const actual = await fetch(new URL('users', url), {
          headers: { origin: 'https://evil.test' },
        });
        expect(actual.status).toBe(200);
        expect(allowOrigin(actual)).toBeNull();
      },
    );
  });

  it('matches a list of origins', async () => {
    await withApp(
      (app) => {
        app.enableCors({ origin: ['https://a.test', 'https://b.test'] });
      },
      async (url) => {
        for (const origin of ['https://a.test', 'https://b.test']) {
          const response = await fetch(new URL('users', url), {
            headers: { origin },
          });
          expect(allowOrigin(response)).toBe(origin);
        }
        const denied = await fetch(new URL('users', url), {
          headers: { origin: 'https://c.test' },
        });
        expect(allowOrigin(denied)).toBeNull();
      },
    );
  });

  it('matches a predicate', async () => {
    await withApp(
      (app) => {
        app.enableCors({ origin: (origin) => origin.endsWith('.internal') });
      },
      async (url) => {
        const allowed = await fetch(new URL('users', url), {
          headers: { origin: 'https://svc.internal' },
        });
        expect(allowOrigin(allowed)).toBe('https://svc.internal');
        const denied = await fetch(new URL('users', url), {
          headers: { origin: 'https://svc.example' },
        });
        expect(allowOrigin(denied)).toBeNull();
      },
    );
  });

  it('wildcards by default, and reflects the caller when credentials are on', async () => {
    await withApp(
      (app) => {
        app.enableCors();
      },
      async (url) => {
        const response = await fetch(new URL('users', url), {
          headers: { origin: 'https://anywhere.test' },
        });
        expect(allowOrigin(response)).toBe('*');
        expect(response.headers.get('vary')).toBeNull();
      },
    );

    await withApp(
      (app) => {
        app.enableCors({ credentials: true });
      },
      async (url) => {
        // `*` is illegal with credentials, so the caller is reflected instead.
        const response = await fetch(new URL('users', url), {
          headers: { origin: 'https://anywhere.test' },
        });
        expect(allowOrigin(response)).toBe('https://anywhere.test');
      },
    );
  });

  it('echoes the requested headers when allowedHeaders is omitted', async () => {
    await withApp(
      (app) => {
        app.enableCors();
      },
      async (url) => {
        const preflight = await fetch(new URL('users', url), {
          method: 'OPTIONS',
          headers: { 'access-control-request-headers': 'x-a, x-b' },
        });
        expect(preflight.headers.get('access-control-allow-headers')).toBe(
          'x-a, x-b',
        );
      },
    );
  });

  it('composes with a global prefix and lets the last call win', async () => {
    await withApp(
      (app) => {
        app
          .setGlobalPrefix('api')
          .enableCors({ origin: 'https://first.test' })
          .enableCors({ origin: 'https://last.test', methods: ['GET'] });
      },
      async (url) => {
        const preflight = await fetch(new URL('api/users', url), {
          method: 'OPTIONS',
          headers: { origin: 'https://last.test' },
        });
        expect(preflight.status).toBe(204);
        expect(allowOrigin(preflight)).toBe('https://last.test');
        expect(preflight.headers.get('access-control-allow-methods')).toBe(
          'GET',
        );
      },
    );
  });

  it('keeps CORS headers on a mapped error response', async () => {
    class Guard implements Middleware {
      handle(): Promise<Response> {
        throw new Error('nope');
      }
    }
    const original = console.error;
    console.error = () => undefined;

    const app = await HttpFactory.create(AppModule);
    app.use(Guard).enableCors({ origin: 'https://example.com' });
    const url = await app.listen(0);
    const response = await fetch(new URL('users', url), {
      headers: { origin: 'https://example.com' },
    });
    await app.shutdown();
    console.error = original;

    expect(response.status).toBe(500);
    expect(allowOrigin(response)).toBe('https://example.com');
  });

  it('adds no OPTIONS handler when CORS is off', async () => {
    await withApp(
      () => undefined,
      async (url) => {
        // Bun answers the method miss itself — nothing mounted OPTIONS.
        expect(
          (await fetch(new URL('users', url), { method: 'OPTIONS' })).status,
        ).toBe(404);
      },
    );
  });
});
