import { describe, expect, it } from 'bun:test';
import { inject, Module, type ModuleRef } from '@dunx/core';
import type { BunRequest } from 'bun';
import { Idempotent } from '../idempotency/decorators.js';
import { IDEMPOTENT_REPLAYED_HEADER } from '../idempotency/guard.js';
import { IdempotencyModule } from '../idempotency/module.js';
import { Controller, Get, Post } from '../route/decorators.js';
import type { RouteInput } from '../route/schema.js';
import { Version } from '../route/version.js';
import type { RouteContext } from '../server/context.js';
import { HttpError } from '../server/errors.js';
import { HttpFactory, type HttpOptions } from '../server/factory.js';
import type { Middleware, Next } from '../server/middleware.js';
import { serving } from '../server/serving.fixture.js';
import { HttpStatusCode } from '../server/status.js';
import { withRequestCookies } from './fallback.js';
import { SignedCookiesModule } from './module.js';
import { SignedCookies } from './signed.js';

const SECRET = 'a-secret-of-at-least-thirty-two-characters';

@Controller('jar')
class JarController {
  private readonly signed = inject(SignedCookies);

  @Get('read')
  read({ req }: RouteInput): { readonly theme: string | null } {
    return { theme: req.cookies.get('theme') };
  }

  @Get('value')
  value({ req }: RouteInput): { readonly ok: boolean } {
    req.cookies.set('theme', 'dark');
    req.cookies.delete('stale');
    return { ok: true };
  }

  @Get('response')
  response({ req }: RouteInput): Response {
    req.cookies.set('theme', 'dark');
    return new Response('built', { headers: { 'set-cookie': 'own=1' } });
  }

  @Get('empty')
  empty({ req }: RouteInput): undefined {
    req.cookies.set('theme', 'dark');
    return undefined;
  }

  @Get('throws')
  throws({ req }: RouteInput): never {
    req.cookies.set('theme', 'dark');
    throw new HttpError(HttpStatusCode.CONFLICT, 'taken');
  }

  @Get('signed')
  sign({ req }: RouteInput): { readonly ok: boolean } {
    this.signed.set(req.cookies, 'prefs', 'compact');
    return { ok: true };
  }

  @Get('signed/read')
  readSigned({ req }: RouteInput): { readonly prefs: string | null } {
    return { prefs: this.signed.get(req.cookies, 'prefs') ?? null };
  }

  @Post('post')
  post({ req }: RouteInput): { readonly ok: boolean } {
    req.cookies.set('posted', '1');
    return { ok: true };
  }
}

let orders = 0;

@Controller('orders')
class OrdersController {
  @Idempotent()
  @Post('')
  create({ req }: RouteInput): { readonly order: number } {
    req.cookies.set('session', `s${++orders}`);
    return { order: orders };
  }
}

@Controller('pinned', { version: '1' })
class PinnedV1 {
  @Get('')
  one({ req }: RouteInput): string {
    req.cookies.set('version', '1');
    return 'v1';
  }
}

@Controller('pinned')
class PinnedV2 {
  @Version('2')
  @Get('')
  two({ req }: RouteInput): string {
    req.cookies.set('version', '2');
    return 'v2';
  }
}

/** Reads a cookie on every request, the unmatched ones included. */
class SessionGuard implements Middleware {
  async handle(req: BunRequest, _ctx: RouteContext, next: Next) {
    if (req.cookies.get('session') !== 'ok') {
      throw new HttpError(HttpStatusCode.UNAUTHORIZED, 'No session');
    }
    return next();
  }
}

/** Serves `/claimed` off the fallback and sets a cookie there. */
class ClaimedCookie implements Middleware {
  claimedPaths(): readonly string[] {
    return ['/claimed'];
  }
  claimedMethods(): readonly string[] {
    return ['GET'];
  }
  async handle(req: BunRequest, _ctx: RouteContext, next: Next) {
    if (new URL(req.url).pathname !== '/claimed') return next();
    req.cookies.set('claimed', req.cookies.get('seen') ?? 'none');
    return new Response('claimed');
  }
}

@Module({
  imports: [
    SignedCookiesModule.forRoot({ secrets: [SECRET] }),
    IdempotencyModule.forRoot({ prefix: 'cookies', subject: () => undefined }),
  ],
  controllers: [JarController, OrdersController],
  providers: [SessionGuard, ClaimedCookie],
})
class JarModule {}

@Module({ controllers: [PinnedV1, PinnedV2] })
class PinnedModule {}

const quiet: HttpOptions = { requestLogging: false, bootLogging: false };

const withApp = (
  run: (url: string) => Promise<void>,
  options: HttpOptions = {},
  root: ModuleRef = JarModule,
  use?: new () => Middleware,
) =>
  serving(
    async () => {
      const app = await HttpFactory.create(root, { ...quiet, ...options });
      if (use !== undefined) app.use(use);
      return app;
    },
    (_app, url) => run(url),
  );

const setCookies = async (
  url: string,
  init?: RequestInit,
): Promise<readonly string[]> =>
  (await fetch(url, init)).headers.getSetCookie();

describe('request cookies', () => {
  it('reads the Cookie header through req.cookies', () =>
    withApp(async (url) => {
      const response = await fetch(`${url}/jar/read`, {
        headers: { cookie: 'theme=light; other=1' },
      });
      expect(await response.json()).toEqual({ theme: 'light' });
    }));

  it('sends a change from a handler returning a value', () =>
    withApp(async (url) => {
      expect(
        await setCookies(`${url}/jar/value`, {
          headers: { cookie: 'stale=1' },
        }),
      ).toEqual([
        'theme=dark; Path=/; SameSite=Lax',
        'stale=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; SameSite=Lax',
      ]);
    }));

  it("keeps a returned Response's own Set-Cookie beside the change", () =>
    withApp(async (url) => {
      expect(await setCookies(`${url}/jar/response`)).toEqual([
        'own=1',
        'theme=dark; Path=/; SameSite=Lax',
      ]);
    }));

  it('sends a change on a 204 and on a mapped error', () =>
    withApp(async (url) => {
      const empty = await fetch(`${url}/jar/empty`);
      expect(empty.status).toBe(204);
      expect(empty.headers.getSetCookie()).toEqual([
        'theme=dark; Path=/; SameSite=Lax',
      ]);
      const refused = await fetch(`${url}/jar/throws`);
      expect(refused.status).toBe(409);
      expect(refused.headers.getSetCookie()).toEqual([
        'theme=dark; Path=/; SameSite=Lax',
      ]);
    }));

  it('sends a change under security headers and on an allowed unsafe request under csrf', () =>
    withApp(
      async (url) => {
        const response = await fetch(`${url}/jar/value`);
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.getSetCookie()).toContain(
          'theme=dark; Path=/; SameSite=Lax',
        );
        const posted = await fetch(`${url}/jar/post`, {
          method: 'POST',
          headers: { 'sec-fetch-site': 'same-origin' },
        });
        expect(posted.status).toBe(201);
        expect(posted.headers.getSetCookie()).toEqual([
          'posted=1; Path=/; SameSite=Lax',
        ]);
        const refused = await fetch(`${url}/jar/post`, {
          method: 'POST',
          headers: { 'sec-fetch-site': 'cross-site' },
        });
        expect(refused.status).toBe(403);
        expect(refused.headers.getSetCookie()).toEqual([]);
      },
      { securityHeaders: true, csrf: true },
    ));

  it('keeps Set-Cookie on a 304, which RFC 6265 section 3 says a client processes', () =>
    withApp(
      async (url) => {
        const first = await fetch(`${url}/jar/value`);
        const etag = first.headers.get('etag') ?? '';
        const revalidated = await fetch(`${url}/jar/value`, {
          headers: { 'if-none-match': etag },
        });
        expect(revalidated.status).toBe(304);
        expect(revalidated.headers.getSetCookie()).toContain(
          'theme=dark; Path=/; SameSite=Lax',
        );
      },
      { etag: true },
    ));

  it('sends the cookie once and never replays it under @Idempotent', () =>
    withApp(async (url) => {
      const init = {
        method: 'POST',
        headers: { 'idempotency-key': `"${Bun.randomUUIDv7()}"` },
      };
      const first = await fetch(`${url}/orders`, init);
      expect(first.headers.getSetCookie()).toEqual([
        `session=s${orders}; Path=/; SameSite=Lax`,
      ]);
      const replay = await fetch(`${url}/orders`, init);
      expect(replay.headers.get(IDEMPOTENT_REPLAYED_HEADER)).toBe('true');
      expect(replay.headers.getSetCookie()).toEqual([]);
    }));

  it('sends the change of the version header versioning picked', () =>
    withApp(
      async (url) => {
        const response = await fetch(`${url}/pinned`, {
          headers: { 'x-api-version': '2' },
        });
        expect(await response.text()).toBe('"v2"');
        expect(response.headers.getSetCookie()).toEqual([
          'version=2; Path=/; SameSite=Lax',
        ]);
      },
      {
        versioning: {
          type: 'header',
          header: 'x-api-version',
          defaultVersion: '1',
        },
      },
      PinnedModule,
    ));
});

describe('fallback cookies', () => {
  it('gives an unmatched request a cookie map, so a guard refuses rather than throws', () =>
    withApp(
      async (url) => {
        const anonymous = await fetch(`${url}/nowhere`);
        expect(anonymous.status).toBe(401);
        const known = await fetch(`${url}/nowhere`, {
          headers: { cookie: 'session=ok' },
        });
        expect(known.status).toBe(404);
      },
      {},
      JarModule,
      SessionGuard,
    ));

  it('sends a change a claimed path made', () =>
    withApp(
      async (url) => {
        expect(
          await setCookies(`${url}/claimed`, {
            headers: { cookie: 'seen=yes' },
          }),
        ).toEqual(['claimed=yes; Path=/; SameSite=Lax']);
      },
      {},
      JarModule,
      ClaimedCookie,
    ));

  it("leaves a request that has Bun's own map alone", async () => {
    const own = new Bun.CookieMap('a=1');
    const req = {
      cookies: own,
      headers: new Headers(),
    } as unknown as BunRequest;
    const handler = withRequestCookies((received) => {
      expect(received.cookies).toBe(own);
      return new Response('ok');
    });
    expect((await handler(req)).headers.getSetCookie()).toEqual([]);
  });

  it('builds no map for a request that never reads one', async () => {
    const req = new Request('http://x/') as BunRequest;
    const handler = withRequestCookies(() =>
      Promise.resolve(new Response('ok')),
    );
    expect((await handler(req)).headers.getSetCookie()).toEqual([]);
  });
});

describe('signed cookies over HTTP', () => {
  it('sets a signed value with secure defaults and reads it back', () =>
    withApp(async (url) => {
      const [header = ''] = await setCookies(`${url}/jar/signed`);
      expect(header).toMatch(
        /^prefs=compact\.[\w-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax$/,
      );
      const cookie = header.slice(0, header.indexOf(';'));
      const read = await fetch(`${url}/jar/signed/read`, {
        headers: { cookie },
      });
      expect(await read.json()).toEqual({ prefs: 'compact' });
    }));

  it('reads a tampered value as absent', () =>
    withApp(async (url) => {
      const [header = ''] = await setCookies(`${url}/jar/signed`);
      const signature = header.slice(header.indexOf('.'), header.indexOf(';'));
      for (const cookie of [
        `prefs=roomy${signature}`,
        'prefs=compact',
        'prefs=',
      ]) {
        const read = await fetch(`${url}/jar/signed/read`, {
          headers: { cookie },
        });
        expect(await read.json()).toEqual({ prefs: null });
      }
    }));
});
