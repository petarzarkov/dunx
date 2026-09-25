import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Module, provide } from '@dunx/core';
import { Compression } from '../compression/compression.js';
import { CompressionModule } from '../compression/module.js';
import { Controller, Get, Post } from '../route/decorators.js';
import type { RouteSchemas } from '../route/schema.js';
import { Sse, type SseInput } from '../sse/decorators.js';
import type { SseEvent } from '../sse/event.js';
import { noneMatch } from './etag.js';
import { HttpFactory } from './factory.js';
import type { HttpOptions } from './options.js';
import { HttpOptionsProvider } from './options-provider.js';
import { serving } from './serving.fixture.js';

const dir = join(tmpdir(), `dunx-etag-${Bun.randomUUIDv7()}`);
const filePath = join(dir, 'data.json');

beforeAll(async () => {
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, '{"from":"disk"}');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let version = 1;

/** Long enough that `Compression` encodes it at its default threshold. */
const LARGE = Array.from({ length: 60 }, (_, id) => ({
  id,
  name: `user-${id}`,
}));

@Controller('things')
class ThingsController {
  @Get('')
  list(): { readonly items: readonly string[]; readonly version: number } {
    return { items: ['a', 'b'], version };
  }

  @Get('text')
  text(): string {
    return 'plain words';
  }

  @Get('large')
  large(): typeof LARGE {
    return LARGE;
  }

  @Get('empty')
  empty(): undefined {
    return undefined;
  }

  @Get('created', { status: 203 })
  created(): { readonly ok: boolean } {
    return { ok: true };
  }

  @Get('own')
  own(): Response {
    return Response.json(
      { own: true },
      { headers: { etag: '"v7"', 'cache-control': 'max-age=60' } },
    );
  }

  @Get('own-missing')
  ownMissing(): Response {
    return new Response('gone', {
      status: 404,
      headers: { etag: '"v7"' },
    });
  }

  @Get('built')
  built(): Response {
    return Response.json(
      { built: true },
      { headers: { 'cache-control': 'no-store' } },
    );
  }

  @Get('file')
  file(): Response {
    return new Response(Bun.file(filePath));
  }

  @Get('stream')
  stream(): Response {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('chunk'));
          controller.close();
        },
      }),
    );
  }

  /** A body the handler already read from, so `cancel()` rejects. */
  @Get('locked')
  locked(): Response {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('held'));
        },
      }),
      { headers: { etag: '"held"' } },
    );
    response.body?.getReader();
    return response;
  }

  /** A 304 the handler answered itself, which request logging must not clone. */
  @Get('unclonable')
  unclonable(): Response {
    const response = new Response(null, {
      status: 304,
      headers: { 'content-type': 'application/json', etag: '"u"' },
    });
    response.clone = () => {
      throw new Error('cloned a 304');
    };
    return response;
  }

  @Get('unserializable')
  unserializable(): unknown {
    return () => 1;
  }

  @Post('')
  create(): { readonly ok: boolean } {
    return { ok: true };
  }

  @Sse('feed')
  async *feed(_input: SseInput<RouteSchemas>): AsyncGenerator<SseEvent> {
    yield { data: 'one' };
  }
}

@Controller('items', { version: '1' })
class ItemsV1Controller {
  @Get('')
  list(): string {
    return 'v1';
  }
}

@Controller('items', { version: '2' })
class ItemsV2Controller {
  @Get('')
  list(): string {
    return 'v2';
  }
}

@Module({ controllers: [ThingsController] })
class AppModule {}

@Module({ controllers: [ItemsV1Controller, ItemsV2Controller] })
class VersionedModule {}

@Module({
  imports: [CompressionModule.forRoot()],
  controllers: [ThingsController],
})
class CompressedModule {}

const withApp = (
  options: HttpOptions,
  run: (url: string) => Promise<void>,
  root: 'plain' | 'compressed' | 'versioned' = 'plain',
): Promise<void> =>
  serving(
    async () => {
      const module = {
        plain: AppModule,
        compressed: CompressedModule,
        versioned: VersionedModule,
      }[root];
      const app = await HttpFactory.create(module, {
        bootLogging: false,
        requestLogging: false,
        ...options,
      });
      if (root === 'compressed') app.use(Compression);
      return app;
    },
    (_app, url) => run(url),
  );

const get = (
  url: string,
  path: string,
  headers: Record<string, string> = {},
  method = 'GET',
): Promise<Response> => fetch(new URL(path, url), { method, headers });

const WEAK = /^W\/"[0-9a-f]{16}"$/;

describe('etag: true', () => {
  it('tags a JSON value with the xxHash3 of the bytes sent', async () => {
    await withApp({ etag: true }, async (url) => {
      const response = await get(url, 'things');
      const bytes = await response.bytes();
      const etag = response.headers.get('etag');
      expect(etag).toMatch(WEAK);
      expect(etag).toBe(
        `W/"${Bun.hash.xxHash3(bytes).toString(16).padStart(16, '0')}"`,
      );
      expect(response.headers.get('content-type')).toBe(
        'application/json;charset=utf-8',
      );
    });
  });

  it('tags a returned string, and the tag follows the value', async () => {
    await withApp({ etag: true }, async (url) => {
      const text = await get(url, 'things/text');
      expect(await text.json()).toBe('plain words');
      expect(text.headers.get('etag')).toMatch(WEAK);

      const first = (await get(url, 'things')).headers.get('etag');
      version += 1;
      const second = (await get(url, 'things')).headers.get('etag');
      version -= 1;
      expect(second).not.toBe(first);
    });
  });

  it('answers HEAD with the tag GET has', async () => {
    await withApp({ etag: true }, async (url) => {
      const got = await get(url, 'things');
      await got.text();
      const head = await get(url, 'things', {}, 'HEAD');
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
      expect(head.headers.get('etag')).toBe(got.headers.get('etag'));

      const conditional = await get(
        url,
        'things',
        { 'if-none-match': got.headers.get('etag')! },
        'HEAD',
      );
      expect(conditional.status).toBe(304);
    });
  });

  it('answers 304 to a matching tag, compared weakly', async () => {
    await withApp({ etag: true }, async (url) => {
      const first = await get(url, 'things');
      await first.text();
      const etag = first.headers.get('etag')!;

      for (const sent of [etag, etag.slice(2)]) {
        const response = await get(url, 'things', { 'if-none-match': sent });
        expect(response.status).toBe(304);
        expect(await response.text()).toBe('');
        expect(response.headers.get('etag')).toBe(etag);
        expect(response.headers.get('content-length')).toBeNull();
      }
    });
  });

  it('answers 200 to a tag that does not match', async () => {
    await withApp({ etag: true }, async (url) => {
      const response = await get(url, 'things', {
        'if-none-match': 'W/"0123456789abcdef"',
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ items: ['a', 'b'] });
    });
  });

  it('matches `*` and any tag in a list', async () => {
    await withApp({ etag: true }, async (url) => {
      const etag = (await get(url, 'things')).headers.get('etag')!;

      const star = await get(url, 'things', { 'if-none-match': '*' });
      expect(star.status).toBe(304);

      const listed = await get(url, 'things', {
        'if-none-match': `"other", ${etag} , W/"third"`,
      });
      expect(listed.status).toBe(304);

      const unlisted = await get(url, 'things', {
        'if-none-match': '"other", W/"third"',
      });
      expect(unlisted.status).toBe(200);
      await unlisted.text();
    });
  });

  it("keeps a handler's own ETag and answers 304 against it", async () => {
    await withApp({ etag: true }, async (url) => {
      const plain = await get(url, 'things/own');
      expect(plain.headers.get('etag')).toBe('"v7"');
      expect(await plain.json()).toEqual({ own: true });

      const response = await get(url, 'things/own', {
        'if-none-match': 'W/"v7"',
      });
      expect(response.status).toBe(304);
      expect(await response.text()).toBe('');
      expect(response.headers.get('etag')).toBe('"v7"');
      expect(response.headers.get('cache-control')).toBe('max-age=60');
      expect(response.headers.get('content-length')).toBeNull();
    });
  });

  it('never answers 304 for a status other than 200', async () => {
    await withApp({ etag: true }, async (url) => {
      const missing = await get(url, 'things/own-missing', {
        'if-none-match': '"v7"',
      });
      expect(missing.status).toBe(404);
      expect(await missing.text()).toBe('gone');

      const created = await get(url, 'things/created', {
        'if-none-match': '*',
      });
      expect(created.status).toBe(203);
      expect(created.headers.get('etag')).toBeNull();
      await created.text();

      const empty = await get(url, 'things/empty', { 'if-none-match': '*' });
      expect(empty.status).toBe(204);
      expect(empty.headers.get('etag')).toBeNull();
    });
  });

  it('never reads a Response the handler built: file, stream, SSE, no-store', async () => {
    await withApp({ etag: true }, async (url) => {
      const bodies: Record<string, string> = {
        'things/file': '{"from":"disk"}',
        'things/stream': 'chunk',
        'things/built': '{"built":true}',
      };
      for (const [path, body] of Object.entries(bodies)) {
        const response = await get(url, path, { 'if-none-match': '*' });
        expect([path, response.status, await response.text()]).toEqual([
          path,
          200,
          body,
        ]);
        expect(response.headers.get('etag')).toBeNull();
      }

      const feed = await get(url, 'things/feed', { 'if-none-match': '*' });
      expect(feed.status).toBe(200);
      expect(feed.headers.get('content-type')).toStartWith('text/event-stream');
      expect(feed.headers.get('etag')).toBeNull();
      await feed.body?.cancel();
    });
  });

  it('answers 304 over a locked body without an unhandled rejection', async () => {
    const rejections: unknown[] = [];
    const record = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on('unhandledRejection', record);
    try {
      await withApp({ etag: true }, async (url) => {
        const response = await get(url, 'things/locked', {
          'if-none-match': '"held"',
        });
        expect(response.status).toBe(304);
        await Bun.sleep(10);
      });
    } finally {
      process.off('unhandledRejection', record);
    }
    expect(rejections).toEqual([]);
  });

  it('logs a 304 without cloning it for its body', async () => {
    await withApp(
      { etag: true, requestLogging: { responseBody: true } },
      async (url) => {
        const response = await get(url, 'things/unclonable');
        expect(response.status).toBe(304);
        expect(response.headers.get('etag')).toBe('"u"');
      },
    );
  });

  it('tags only GET routes', async () => {
    await withApp({ etag: true }, async (url) => {
      const response = await get(
        url,
        'things',
        { 'if-none-match': '*' },
        'POST',
      );
      expect(response.status).toBe(201);
      expect(response.headers.get('etag')).toBeNull();
      await response.text();
    });
  });

  it('maps a value JSON cannot take to a 500, as it does without etag', async () => {
    for (const etag of [true, false]) {
      await withApp({ etag }, async (url) => {
        const response = await get(url, 'things/unserializable');
        expect(response.status).toBe(500);
        await response.text();
      });
    }
  });

  it('tags on the middleware path as on the direct one', async () => {
    await withApp({ etag: true, requestLogging: true }, async (url) => {
      const first = await get(url, 'things');
      await first.text();
      const response = await get(url, 'things', {
        'if-none-match': first.headers.get('etag')!,
      });
      expect(response.status).toBe(304);
    });
  });

  it('carries the security headers and CORS on a 304', async () => {
    await withApp(
      { etag: true, securityHeaders: true, cors: { origin: 'https://a.test' } },
      async (url) => {
        const etag = (await get(url, 'things')).headers.get('etag')!;
        const response = await get(url, 'things', {
          'if-none-match': etag,
          origin: 'https://a.test',
        });
        expect(response.status).toBe(304);
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(response.headers.get('access-control-allow-origin')).toBe(
          'https://a.test',
        );
      },
    );
  });

  it('tags each version of a header-versioned path, and varies the 304', async () => {
    await withApp(
      { etag: true, versioning: { type: 'header', header: 'X-API-Version' } },
      async (url) => {
        const v1 = await get(url, 'items', { 'x-api-version': '1' });
        const v2 = await get(url, 'items', { 'x-api-version': '2' });
        expect(await v1.json()).toBe('v1');
        expect(await v2.json()).toBe('v2');
        const tag1 = v1.headers.get('etag')!;
        expect(tag1).not.toBe(v2.headers.get('etag'));

        const again = await get(url, 'items', {
          'x-api-version': '1',
          'if-none-match': tag1,
        });
        expect(again.status).toBe(304);
        expect(again.headers.get('vary')).toContain('X-API-Version');

        const other = await get(url, 'items', {
          'x-api-version': '2',
          'if-none-match': tag1,
        });
        expect(other.status).toBe(200);
        await other.text();
      },
      'versioned',
    );
  });

  it('tags a URI-versioned route', async () => {
    await withApp(
      { etag: true, versioning: { type: 'uri' } },
      async (url) => {
        const response = await get(url, 'v2/items');
        expect(await response.json()).toBe('v2');
        expect(response.headers.get('etag')).toMatch(WEAK);
      },
      'versioned',
    );
  });
});

describe('etag with Compression', () => {
  it('tags the identity bytes, so every encoding shares one tag', async () => {
    await withApp(
      { etag: true },
      async (url) => {
        const identity = await get(url, 'things/large', {
          'accept-encoding': 'identity',
        });
        const bytes = await identity.bytes();
        const gzip = await get(url, 'things/large', {
          'accept-encoding': 'gzip',
        });
        await gzip.text();
        expect(identity.headers.get('content-encoding')).toBeNull();
        expect(gzip.headers.get('content-encoding')).toBe('gzip');
        expect(gzip.headers.get('etag')).toBe(identity.headers.get('etag'));
        expect(gzip.headers.get('etag')).toBe(
          `W/"${Bun.hash.xxHash3(bytes).toString(16).padStart(16, '0')}"`,
        );
      },
      'compressed',
    );
  });

  it('answers 304 with the Vary the 200 carried, and encodes nothing', async () => {
    await withApp(
      { etag: true },
      async (url) => {
        const first = await get(url, 'things/large', {
          'accept-encoding': 'gzip',
        });
        await first.text();
        expect(first.headers.get('vary')).toBe('accept-encoding');

        const response = await get(url, 'things/large', {
          'accept-encoding': 'gzip',
          'if-none-match': first.headers.get('etag')!,
        });
        expect(response.status).toBe(304);
        expect(response.headers.get('vary')).toBe('accept-encoding');
        expect(response.headers.get('content-encoding')).toBeNull();
      },
      'compressed',
    );
  });

  it('weakens a strong tag it encodes, and the weak one still matches', async () => {
    await withApp(
      { etag: { weak: false } },
      async (url) => {
        const identity = await get(url, 'things/large', {
          'accept-encoding': 'identity',
        });
        await identity.text();
        const strong = identity.headers.get('etag')!;
        expect(strong).toMatch(/^"[0-9a-f]+"$/);

        const gzip = await get(url, 'things/large', {
          'accept-encoding': 'gzip',
        });
        await gzip.text();
        expect(gzip.headers.get('etag')).toBe(`W/${strong}`);

        const again = await get(url, 'things/large', {
          'accept-encoding': 'gzip',
          'if-none-match': `W/${strong}`,
        });
        expect(again.status).toBe(304);
        expect(again.headers.get('etag')).toBe(gzip.headers.get('etag'));
      },
      'compressed',
    );
  });
});

describe('etag off', () => {
  it('tags nothing and ignores If-None-Match, absent or false', async () => {
    for (const options of [{}, { etag: false }]) {
      await withApp(options, async (url) => {
        const response = await get(url, 'things', { 'if-none-match': '*' });
        expect(response.status).toBe(200);
        expect(response.headers.get('etag')).toBeNull();
        await response.text();

        const own = await get(url, 'things/own', { 'if-none-match': '"v7"' });
        expect(own.status).toBe(200);
        await own.text();
      });
    }
  });

  it('is turned on by an HttpOptionsProvider', async () => {
    class Options extends HttpOptionsProvider {
      override get etag(): boolean {
        return true;
      }
    }
    @Module({
      imports: [AppModule],
      providers: [provide(HttpOptionsProvider, { useClass: Options })],
    })
    class ProvidedModule {}

    await serving(
      () =>
        HttpFactory.create(ProvidedModule, {
          bootLogging: false,
          requestLogging: false,
        }),
      async (_app, url) => {
        const response = await get(url, 'things');
        await response.text();
        expect(response.headers.get('etag')).toMatch(WEAK);
      },
    );
  });
});

describe('noneMatch', () => {
  it('compares weakly, and finds a tag holding a comma', () => {
    expect(noneMatch('W/"a"', '"a"')).toBe(true);
    expect(noneMatch('"a"', 'W/"a"')).toBe(true);
    expect(noneMatch('"x,y", "b"', 'W/"x,y"')).toBe(true);
    expect(noneMatch(' * ', 'W/"a"')).toBe(true);
  });

  it('matches no partial or unquoted tag', () => {
    expect(noneMatch('"ab"', '"a"')).toBe(false);
    expect(noneMatch('a', '"a"')).toBe(false);
    expect(noneMatch('"xa"', '"a"')).toBe(false);
    expect(noneMatch('', '"a"')).toBe(false);
  });
});
