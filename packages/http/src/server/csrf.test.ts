import { describe, expect, it } from 'bun:test';
import { ConsoleLogger, Logger, Module, provide } from '@dunx/core';
import { Controller, Delete, Get, Post } from '../route/decorators.js';
import { crossOriginCheck, trustedOriginSet } from './csrf.js';
import { ThrottledWarning } from './throttled-warning.js';
import { HttpFactory } from './factory.js';
import type { HttpOptions } from './options.js';
import { HttpOptionsProvider } from './options-provider.js';
import { serving } from './serving.fixture.js';

@Controller('/things')
class ThingsController {
  @Get('/')
  list(): string[] {
    return ['a'];
  }

  @Post('/')
  create(): { created: true } {
    return { created: true };
  }

  @Delete('/:id')
  remove(): string {
    return 'gone';
  }
}

@Module({ controllers: [ThingsController] })
class AppModule {}

const withApp = (
  options: HttpOptions,
  run: (url: string) => Promise<void>,
  module: object = AppModule,
): Promise<void> =>
  serving(
    () =>
      HttpFactory.create(module as typeof AppModule, {
        bootLogging: false,
        requestLogging: false,
        ...options,
      }),
    (_app, url) => run(url),
  );

const send = (
  url: string,
  path: string,
  method: string,
  headers: Record<string, string> = {},
): Promise<Response> =>
  fetch(new URL(path, url), {
    method,
    headers,
    ...(method === 'POST' && { body: '{}' }),
  });

const CROSS_SITE = {
  origin: 'https://evil.test',
  'sec-fetch-site': 'cross-site',
};

describe('csrf: true', () => {
  it('lets every safe method through, whatever the headers say', async () => {
    await withApp({ csrf: true }, async (url) => {
      for (const method of ['GET', 'HEAD']) {
        const response = await send(url, 'things', method, CROSS_SITE);
        await response.text();
        expect([method, response.status]).toEqual([method, 200]);
      }
    });
  });

  it('admits same-origin and none, and refuses same-site and cross-site', async () => {
    await withApp({ csrf: true }, async (url) => {
      const statuses: Record<string, number> = {};
      for (const site of ['same-origin', 'none', 'same-site', 'cross-site']) {
        const response = await send(url, 'things', 'POST', {
          'sec-fetch-site': site,
        });
        await response.text();
        statuses[site] = response.status;
      }
      expect(statuses).toEqual({
        'same-origin': 201,
        none: 201,
        'same-site': 403,
        'cross-site': 403,
      });
    });
  });

  it('refuses with the framework error shape', async () => {
    await withApp({ csrf: true }, async (url) => {
      const response = await send(url, 'things/1', 'DELETE', CROSS_SITE);
      expect(response.status).toBe(403);
      expect(response.headers.get('content-type')).toContain(
        'application/json',
      );
      expect(await response.json()).toEqual({
        error: 'CROSS_ORIGIN_REQUEST',
        status: 403,
      });
    });
  });

  it('refuses an unsafe method on an unmatched path before it becomes a 404', async () => {
    await withApp({ csrf: true }, async (url) => {
      const refused = await send(url, 'nope', 'POST', CROSS_SITE);
      expect(refused.status).toBe(403);
      const missed = await send(url, 'nope', 'POST');
      expect(missed.status).toBe(404);
    });
  });

  it('falls back to comparing Origin with Host when Sec-Fetch-Site is absent', async () => {
    await withApp({ csrf: true }, async (url) => {
      const self = new URL(url).origin;
      const same = await send(url, 'things', 'POST', { origin: self });
      expect(same.status).toBe(201);
      const other = await send(url, 'things', 'POST', {
        origin: 'https://evil.test',
      });
      expect(other.status).toBe(403);
    });
  });

  it('admits a request carrying neither header, which no browser sends', async () => {
    await withApp({ csrf: true }, async (url) => {
      const response = await send(url, 'things', 'POST');
      expect(response.status).toBe(201);
    });
  });

  it('admits a trusted origin through both checks', async () => {
    const options = { csrf: { trustedOrigins: ['https://partner.test'] } };
    await withApp(options, async (url) => {
      const fetched = await send(url, 'things', 'POST', {
        origin: 'https://partner.test',
        'sec-fetch-site': 'cross-site',
      });
      expect(fetched.status).toBe(201);
      const old = await send(url, 'things', 'POST', {
        origin: 'https://partner.test',
      });
      expect(old.status).toBe(201);
      const other = await send(url, 'things', 'POST', CROSS_SITE);
      expect(other.status).toBe(403);
    });
  });

  it('matches the forwarded host behind a trusted proxy, and only then', async () => {
    const headers = {
      origin: 'https://shop.example',
      'x-forwarded-host': 'shop.example',
    };
    await withApp({ csrf: true, trustProxy: true }, async (url) => {
      const response = await send(url, 'things', 'POST', headers);
      expect(response.status).toBe(201);
      const spoofed = await send(url, 'things', 'POST', {
        origin: 'https://evil.test',
        'x-forwarded-host': 'evil.test, shop.example',
      });
      expect(spoofed.status).toBe(403);
    });
    await withApp({ csrf: true }, async (url) => {
      const response = await send(url, 'things', 'POST', headers);
      expect(response.status).toBe(403);
    });
  });

  it('answers a CORS preflight, and refuses the cross-site call it precedes', async () => {
    const options = {
      csrf: true,
      cors: { origin: 'https://evil.test' },
    } as const;
    await withApp(options, async (url) => {
      const preflight = await send(url, 'things', 'OPTIONS', {
        ...CROSS_SITE,
        'access-control-request-method': 'POST',
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get('access-control-allow-origin')).toBe(
        'https://evil.test',
      );
      const refused = await send(url, 'things', 'POST', CROSS_SITE);
      expect(refused.status).toBe(403);
    });
  });

  it('stamps the refusal with the security headers', async () => {
    await withApp({ csrf: true, securityHeaders: true }, async (url) => {
      const response = await send(url, 'things', 'POST', CROSS_SITE);
      expect(response.status).toBe(403);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });
  });

  it('refuses with a status an onError filter chose', async () => {
    const options: HttpOptions = {
      csrf: true,
      onError: (error) =>
        new Response(String((error as Error).message), { status: 418 }),
    };
    await withApp(options, async (url) => {
      const response = await send(url, 'things', 'POST', CROSS_SITE);
      expect(response.status).toBe(418);
      expect(await response.text()).toBe('CROSS_ORIGIN_REQUEST');
    });
  });
});

class Recorder extends ConsoleLogger {
  readonly warnings: { message: string; fields: unknown }[] = [];

  constructor() {
    super(undefined, 'info', false);
  }

  override warn(message: unknown, ...rest: unknown[]): void {
    this.warnings.push({ message: String(message), fields: rest[0] });
  }
}

describe('csrf refusal log', () => {
  const recorder = new Recorder();

  @Module({
    controllers: [ThingsController],
    providers: [provide(Logger, { useValue: recorder })],
    exports: [Logger],
    global: true,
  })
  class LoggedModule {}

  const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

  it('writes nothing for a request let through, and a warn for a refusal', async () => {
    recorder.warnings.length = 0;
    await withApp(
      { csrf: true },
      async (url) => {
        await send(url, 'things', 'POST', { 'sec-fetch-site': 'same-origin' });
        await send(url, 'things', 'POST');
        expect(recorder.warnings).toEqual([]);

        await send(url, 'things?next=/admin', 'POST', {
          ...CROSS_SITE,
          traceparent,
        });
        expect(recorder.warnings).toEqual([
          {
            message: 'CSRF refused POST /things',
            fields: {
              method: 'POST',
              path: '/things',
              secFetchSite: 'cross-site',
              origin: 'https://evil.test',
              reason: 'cross-origin',
              traceparent,
            },
          },
        ]);
      },
      LoggedModule,
    );
  });

  it('names the Origin fallback as the reason, and throttles a burst', async () => {
    recorder.warnings.length = 0;
    await withApp(
      { csrf: true },
      async (url) => {
        for (let i = 0; i < 5; i++) {
          const refused = await send(url, 'things/1', 'DELETE', {
            origin: 'https://evil.test',
          });
          expect(refused.status).toBe(403);
        }
        // Five refusals inside one interval: the first is written.
        expect(recorder.warnings).toEqual([
          {
            message: 'CSRF refused DELETE /things/1',
            fields: {
              method: 'DELETE',
              path: '/things/1',
              secFetchSite: null,
              origin: 'https://evil.test',
              reason: 'origin-mismatch',
            },
          },
        ]);
      },
      LoggedModule,
    );
  });
});

describe('ThrottledWarning', () => {
  it('writes one line per interval and carries the count it dropped', () => {
    const recorder = new Recorder();
    let now = 0;
    const warning = new ThrottledWarning(recorder, 1000, () => now);

    warning.warn('a', { n: 1 });
    now = 500;
    warning.warn('b', { n: 2 });
    warning.warn('c', { n: 3 });
    now = 1000;
    warning.warn('d', { n: 4 });
    now = 1200;
    warning.warn('e', { n: 5 });
    now = 5000;
    warning.warn('f', { n: 6 });

    expect(recorder.warnings).toEqual([
      { message: 'a', fields: { n: 1 } },
      { message: 'd', fields: { n: 4, suppressed: 2 } },
      { message: 'f', fields: { n: 6, suppressed: 1 } },
    ]);
  });

  it('defaults to one line a second on a monotonic clock', () => {
    const recorder = new Recorder();
    const warning = new ThrottledWarning(recorder);
    warning.warn('a', {});
    warning.warn('b', {});
    expect(recorder.warnings).toEqual([{ message: 'a', fields: {} }]);
  });
});

describe('csrf off', () => {
  it('is off by default', async () => {
    await withApp({}, async (url) => {
      const response = await send(url, 'things', 'POST', CROSS_SITE);
      expect(response.status).toBe(201);
    });
  });

  it('is off with false', async () => {
    await withApp({ csrf: false }, async (url) => {
      const response = await send(url, 'things', 'POST', CROSS_SITE);
      expect(response.status).toBe(201);
    });
  });
});

describe('csrf from HttpOptionsProvider', () => {
  class Settings extends HttpOptionsProvider {
    override get csrf(): { trustedOrigins: readonly string[] } {
      return { trustedOrigins: ['https://partner.test'] };
    }
  }

  @Module({
    controllers: [ThingsController],
    providers: [provide(HttpOptionsProvider, { useClass: Settings })],
  })
  class ConfiguredModule {}

  it('reads the getter, and lets the argument win', async () => {
    const partner = { ...CROSS_SITE, origin: 'https://partner.test' };
    await withApp(
      {},
      async (url) => {
        expect((await send(url, 'things', 'POST', partner)).status).toBe(201);
        expect((await send(url, 'things', 'POST', CROSS_SITE)).status).toBe(
          403,
        );
      },
      ConfiguredModule,
    );
    await withApp(
      { csrf: false },
      async (url) => {
        expect((await send(url, 'things', 'POST', CROSS_SITE)).status).toBe(
          201,
        );
      },
      ConfiguredModule,
    );
  });
});

describe('trusted origins', () => {
  it('rejects an entry that is not a bare origin at boot', () => {
    for (const entry of [
      'partner.test',
      'https://',
      'https://partner.test/',
      'https://partner.test/path',
      'https://partner.test?q=1',
    ]) {
      expect(() => trustedOriginSet([entry])).toThrow(entry);
    }
  });

  it('fails HttpFactory.create, not listen(), on a malformed entry', async () => {
    const entry = 'https://partner.test/';
    await expect(
      HttpFactory.create(AppModule, {
        bootLogging: false,
        csrf: { trustedOrigins: [entry] },
      }),
    ).rejects.toThrow(entry);
  });

  it('keeps a bare origin as written', () => {
    expect([
      ...trustedOriginSet(['https://partner.test', 'http://localhost:5173']),
    ]).toEqual(['https://partner.test', 'http://localhost:5173']);
  });
});

describe('crossOriginCheck', () => {
  const refusal = crossOriginCheck({}, false);
  const allows = (req: Request): boolean => refusal(req) === undefined;
  const request = (headers: Record<string, string>): Request =>
    new Request('http://app.test/x', { method: 'POST', headers });

  it('refuses a Sec-Fetch-Site value it does not know, as Go does', () => {
    expect(allows(request({ 'sec-fetch-site': 'Same-Origin' }))).toBe(false);
  });

  it('refuses an opaque or unparseable Origin as a mismatch', () => {
    for (const origin of ['null', 'not a url', 'http://']) {
      expect([origin, refusal(request({ origin, host: 'app.test' }))]).toEqual([
        origin,
        'origin-mismatch',
      ]);
    }
  });

  it('compares the host an Origin parses to, not its spelling', () => {
    const host = 'app.test';
    expect(allows(request({ origin: 'http://APP.test', host }))).toBe(true);
    expect(allows(request({ origin: 'https://app.test:443', host }))).toBe(
      true,
    );
  });

  it('counts X-Forwarded-Host from the right by the hop count', () => {
    const behindTwo = crossOriginCheck({}, 2);
    const req = request({
      origin: 'https://shop.example',
      'x-forwarded-host': 'evil.test, shop.example, edge.internal',
    });
    expect(behindTwo(req)).toBeUndefined();
    expect(refusal(req)).toBe('origin-mismatch');
  });

  it('compares the port as part of the host', () => {
    const origin = 'http://app.test:8080';
    expect(allows(request({ origin, host: 'app.test:8080' }))).toBe(true);
    expect(allows(request({ origin, host: 'app.test' }))).toBe(false);
  });
});
