import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Module, provide } from '@dunx/core';
import { Controller, Get } from '../route/decorators.js';
import type { RouteSchemas } from '../route/schema.js';
import { Sse, type SseInput } from '../sse/decorators.js';
import type { SseEvent } from '../sse/event.js';
import { StaticFiles } from '../static/files.js';
import { StaticModule } from '../static/module.js';
import { HttpError } from './errors.js';
import { HttpFactory } from './factory.js';
import type { HttpOptions } from './options.js';
import { HttpOptionsProvider } from './options-provider.js';
import {
  SecuredResponses,
  securityHeaderPairs,
  STRICT_CSP,
} from './security-headers.js';
import { inlineScriptPolicy } from './html.js';
import { serving } from './serving.fixture.js';

const root = join(tmpdir(), `dunx-security-${Bun.randomUUIDv7()}`);

beforeAll(async () => {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'app.js'), 'export const a = 1;');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

@Controller('/things')
class ThingsController {
  @Get('/')
  list(): string[] {
    return ['a'];
  }

  @Get('/broken')
  broken(): never {
    throw new HttpError(409, 'CONFLICT');
  }

  /** A page that has to be framed says so on its own response. */
  @Get('/framed')
  framed(): Response {
    return new Response('ok', { headers: { 'x-frame-options': 'SAMEORIGIN' } });
  }

  @Sse('/feed')
  async *feed(_input: SseInput<RouteSchemas>): AsyncGenerator<SseEvent> {
    yield { data: 'one' };
  }
}

@Module({
  imports: [StaticModule.forRoot({ root, path: '/assets' })],
  controllers: [ThingsController],
})
class AppModule {}

const DEFAULT_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'x-dns-prefetch-control': 'off',
  'origin-agent-cluster': '?1',
};

const pick = (response: Response): Record<string, string | null> =>
  Object.fromEntries(
    [...Object.keys(DEFAULT_HEADERS), 'content-security-policy'].map((name) => [
      name,
      response.headers.get(name),
    ]),
  );

const withApp = (
  options: HttpOptions,
  run: (url: string) => Promise<void>,
  module: object = AppModule,
): Promise<void> =>
  serving(
    async () => {
      const app = await HttpFactory.create(module as typeof AppModule, {
        bootLogging: false,
        requestLogging: false,
        ...options,
      });
      app.use(StaticFiles);
      return app;
    },
    (_app, url) => run(url),
  );

describe('securityHeaders: true', () => {
  it('stamps a matched route, the 404, a mapped error and an SSE stream', async () => {
    await withApp({ securityHeaders: true }, async (url) => {
      for (const path of ['things', 'nope', 'things/broken', 'things/feed']) {
        const response = await fetch(new URL(path, url));
        await response.text();
        expect([path, pick(response)]).toEqual([
          path,
          { ...DEFAULT_HEADERS, 'content-security-policy': null },
        ]);
      }
    });
  });

  it('stamps a static file served off the fallback', async () => {
    await withApp({ securityHeaders: true }, async (url) => {
      const response = await fetch(new URL('assets/app.js', url));
      await response.text();
      expect(response.status).toBe(200);
      expect(pick(response)).toMatchObject(DEFAULT_HEADERS);
    });
  });

  it('stamps the direct path and the middleware path alike', async () => {
    await withApp(
      { securityHeaders: true, requestLogging: true },
      async (url) => {
        const response = await fetch(new URL('things', url));
        expect(await response.json()).toEqual(['a']);
        expect(pick(response)).toMatchObject(DEFAULT_HEADERS);
      },
    );
  });

  it('keeps a header the handler set itself', async () => {
    await withApp({ securityHeaders: true }, async (url) => {
      const response = await fetch(new URL('things/framed', url));
      expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    });
  });

  it('stamps a CORS preflight and a trailing-slash alias', async () => {
    await withApp(
      { securityHeaders: true, cors: {}, strict: false },
      async (url) => {
        const preflight = await fetch(new URL('things', url), {
          method: 'OPTIONS',
          headers: {
            origin: 'https://a.test',
            'access-control-request-method': 'GET',
          },
        });
        expect(preflight.status).toBe(204);
        expect(pick(preflight)).toMatchObject(DEFAULT_HEADERS);

        const aliased = await fetch(new URL('things/', url));
        expect(aliased.status).toBe(200);
        expect(pick(aliased)).toMatchObject(DEFAULT_HEADERS);
      },
    );
  });
});

describe('securityHeaders off', () => {
  it('adds nothing when absent or false', async () => {
    for (const options of [{}, { securityHeaders: false }]) {
      await withApp(options, async (url) => {
        for (const path of ['things', 'nope', 'things/broken']) {
          const response = await fetch(new URL(path, url));
          await response.text();
          expect(response.headers.get('referrer-policy')).toBeNull();
          expect(response.headers.get('strict-transport-security')).toBeNull();
        }
      });
    }
  });
});

describe('SecurityHeadersOptions', () => {
  it('overrides one header, drops another, and adds a CSP', async () => {
    await withApp(
      {
        securityHeaders: {
          referrerPolicy: 'strict-origin-when-cross-origin',
          strictTransportSecurity: false,
          contentSecurityPolicy: true,
        },
      },
      async (url) => {
        const response = await fetch(new URL('things', url));
        expect(pick(response)).toEqual({
          ...DEFAULT_HEADERS,
          'referrer-policy': 'strict-origin-when-cross-origin',
          'strict-transport-security': null,
          'content-security-policy': STRICT_CSP,
        });
      },
    );
  });

  it('sends a CSP string as given, and none for false', () => {
    expect(
      securityHeaderPairs({ contentSecurityPolicy: "default-src 'none'" })[0],
    ).toEqual(['content-security-policy', "default-src 'none'"]);
    expect(
      securityHeaderPairs({ contentSecurityPolicy: false }).map(([n]) => n),
    ).not.toContain('content-security-policy');
    expect(
      securityHeaderPairs({
        xContentTypeOptions: false,
        xFrameOptions: false,
        crossOriginOpenerPolicy: false,
        xDnsPrefetchControl: false,
        originAgentCluster: false,
        referrerPolicy: false,
        strictTransportSecurity: false,
      }),
    ).toEqual([]);
  });
});

describe('HttpOptionsProvider.securityHeaders', () => {
  class SecureOptions extends HttpOptionsProvider {
    override get securityHeaders(): { xFrameOptions: string } {
      return { xFrameOptions: 'SAMEORIGIN' };
    }
  }

  @Module({
    imports: [AppModule],
    providers: [provide(HttpOptionsProvider, { useClass: SecureOptions })],
  })
  class ProvidedModule {}

  it('is answered from the container, and the argument still wins', async () => {
    await withApp(
      {},
      async (url) => {
        const response = await fetch(new URL('things', url));
        expect(response.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      },
      ProvidedModule,
    );
    await withApp(
      { securityHeaders: false },
      async (url) => {
        const response = await fetch(new URL('things', url));
        expect(response.headers.get('x-frame-options')).toBeNull();
      },
      ProvidedModule,
    );
  });
});

describe('SecuredResponses', () => {
  const secured = new SecuredResponses(securityHeaderPairs({}));
  const req = new Request('http://x.test/') as Bun.BunRequest;

  it('answers synchronously when the handler did', () => {
    const response = secured.wrap(() => new Response('x'))(req);
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get('x-frame-options')).toBe('DENY');
  });

  it('adopts a promise when the handler returned one', async () => {
    const response = secured.wrap(async () => new Response('x'))(req);
    expect(response).toBeInstanceOf(Promise);
    expect((await response).headers.get('x-frame-options')).toBe('DENY');
  });

  it('builds json and empty responses already carrying every header', () => {
    const json = secured.json({ a: 1 }, 201);
    const empty = secured.empty(204);
    for (const response of [json, empty]) {
      expect(response.headers.get('x-frame-options')).toBe('DENY');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
    expect(json.status).toBe(201);
    expect(json.headers.get('content-type')).toContain('application/json');
    expect(empty.status).toBe(204);
  });

  /** The prebuilt `Headers` is shared by every response built from it. */
  it('keeps a header set on one built response off the next', () => {
    const first = secured.json({}, 200);
    first.headers.set('x-frame-options', 'SAMEORIGIN');
    expect(secured.json({}, 200).headers.get('x-frame-options')).toBe('DENY');
  });

  it('stamps a response it did not build, keeping a header it set itself', () => {
    const own = new Response('x', {
      headers: { 'x-frame-options': 'SAMEORIGIN' },
    });
    const stamped = secured.stamp(own);
    expect(stamped.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(stamped.headers.get('x-content-type-options')).toBe('nosniff');
  });
});

describe('inlineScriptPolicy', () => {
  const sha = (text: string): string =>
    `'sha256-${new Bun.CryptoHasher('sha256').update(text).digest('base64')}'`;

  it('hashes each inline script that runs, and nothing else', () => {
    const html =
      '<script src="/a.js"></script>' +
      '<script type="application/json">{"a":1}</script>' +
      '<script>var a = 1 < 2;</script>' +
      '<script type="module">import "/m.js";</script>' +
      '<script>var a = 1 < 2;</script>';
    expect(inlineScriptPolicy(html)).toBe(
      `script-src 'self' ${sha('var a = 1 < 2;')} ${sha('import "/m.js";')}; ` +
        "object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
    );
  });

  it('hashes every script type a browser runs, and no data block', () => {
    const runs = [
      'text/ecmascript',
      'application/ecmascript',
      'text/jscript',
      'text/livescript',
      'importmap',
      'speculationrules',
    ];
    const html =
      runs.map((type, i) => `<script type="${type}">${i}</script>`).join('') +
      '<script type="application/ld+json">{}</script>' +
      '<script type="text/plain">x</script>';
    expect(inlineScriptPolicy(html)).toBe(
      `script-src 'self' ${runs.map((_, i) => sha(String(i))).join(' ')}; ` +
        "object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
    );
  });

  it('admits the origin of each off-origin script the page loads', () => {
    const html =
      '<script src="https://cdn.example.com/a/ui.js"></script>' +
      '<script src="//cdn.example.com/b.js"></script>' +
      '<script src="http://other.test:8080/c.js"></script>' +
      '<script src="/local.js"></script>' +
      '<script src="data:text/javascript,1"></script>';
    expect(inlineScriptPolicy(html)).toBe(
      "script-src 'self' https://cdn.example.com cdn.example.com " +
        'http://other.test:8080; ' +
        "object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
    );
  });

  it('admits same-origin files only when a page has no inline script', () => {
    expect(inlineScriptPolicy('<p>hi</p>')).toBe(
      "script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'self'",
    );
  });
});
