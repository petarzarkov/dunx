import { describe, expect, it } from 'bun:test';
import { Logger, Module, RequestContext } from '@dunx/core';
import { Controller, Get, Post } from '../route/decorators.js';
import type { Input, RouteSchemas } from '../route/schema.js';
import { HttpError } from './errors.js';
import { HttpFactory, type HttpApp } from './factory.js';

/** Captures both streams: warn and above go to stderr by design. */
const captured = async (
  run: () => Promise<void>,
): Promise<Record<string, unknown>[]> => {
  const lines: string[] = [];
  const { log, error } = console;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) =>
    lines.push(args.map(String).join(' '));
  try {
    await run();
  } finally {
    console.log = log;
    console.error = error;
  }
  return lines
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

@Controller('things')
class ThingsController {
  @Get('/')
  list(): readonly string[] {
    return ['one'];
  }

  @Post('/')
  create(input: Input<RouteSchemas>): Promise<unknown> {
    return input.req.json();
  }

  @Get('/boom')
  boom(): never {
    throw new HttpError(418, 'teapot');
  }

  @Get('/broken')
  broken(): never {
    throw new Error('unhandled');
  }

  /** Proves the handler's own entries inherit the request scope. */
  @Get('/inner')
  inner(): { ok: true } {
    logger?.info('from the handler');
    return { ok: true };
  }
}

// Set from the container inside the test that needs it.
let logger: Logger | undefined;

@Module({ controllers: [ThingsController] })
class ThingsModule {}

const withApp = async (
  run: (app: HttpApp, url: string) => Promise<void>,
  options: Parameters<typeof HttpFactory.create>[1] = {},
): Promise<void> => {
  const app = await HttpFactory.create(ThingsModule, options);
  const url = await app.listen(0);
  try {
    await run(app, url);
  } finally {
    await app.shutdown();
  }
};

describe('request logging', () => {
  it('is on with no logging module imported at all', async () => {
    const entries = await captured(async () => {
      await withApp(async (_app, url) => {
        await fetch(new URL('things', url));
      });
    });

    // Core binds a default ConsoleLogger and RequestContext, which is what lets
    // this work in an app that configured nothing.
    const entry = entries.find((e) => e['message'] === 'GET /things 200');
    expect(entry).toBeDefined();
    expect(entry?.['statusCode']).toBe(200);
    expect(entry?.['responseBody']).toEqual(['one']);
    expect(entry?.['context']).toBe('ThingsController.list');
    expect(typeof entry?.['requestId']).toBe('string');
    expect(typeof entry?.['elapsedMs']).toBe('number');
  });

  it('emits exactly one entry per request, carrying both halves', async () => {
    const entries = await captured(async () => {
      await withApp(async (_app, url) => {
        await fetch(new URL('things', url), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'ada' }),
        });
      });
    });

    const matched = entries.filter((e) =>
      String(e['message']).startsWith('POST /things'),
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]?.['request']).toMatchObject({ body: { name: 'ada' } });
    expect(matched[0]?.['responseBody']).toEqual({ name: 'ada' });
  });

  it('reuses an inbound x-request-id and returns it', async () => {
    // A holder, not a `let`: assigning inside a closure keeps TypeScript's
    // narrowing from the initialiser, and `null` is not a useful type.
    const seen: { header?: string | undefined } = {};
    const entries = await captured(async () => {
      await withApp(async (_app, url) => {
        const response = await fetch(new URL('things', url), {
          headers: { 'x-request-id': 'given-1' },
        });
        seen.header = response.headers.get('x-request-id') ?? undefined;
      });
    });

    expect(seen.header).toBe('given-1');
    expect(entries.find((e) => e['requestId'] === 'given-1')).toBeDefined();
  });

  it('logs a 4xx at warn and a 5xx at error', async () => {
    const entries = await captured(async () => {
      await withApp(async (_app, url) => {
        await fetch(new URL('things/boom', url));
        await fetch(new URL('things/broken', url));
      });
    });

    expect(
      entries.find((e) => e['message'] === 'GET /things/boom 418')?.['level'],
    ).toBe('warn');
    expect(
      entries.find((e) => e['message'] === 'GET /things/broken 500')?.['level'],
    ).toBe('error');
  });

  it('puts the handler’s own entries in the same request scope', async () => {
    const entries = await captured(async () => {
      await withApp(async (app, url) => {
        logger = app.get(Logger);
        await fetch(new URL('things/inner', url));
        logger = undefined;
      });
    });

    const inner = entries.find((e) => e['message'] === 'from the handler');
    const outer = entries.find((e) => e['message'] === 'GET /things/inner 200');
    expect(inner).toBeDefined();
    // Nothing was passed to the handler: AsyncLocalStorage carried it.
    expect(inner?.['requestId']).toBe(outer?.['requestId']);
    expect(inner?.['context']).toBe('ThingsController.inner');
  });

  it('logs an unmatched path, which Bun would otherwise answer silently', async () => {
    const entries = await captured(async () => {
      await withApp(async (_app, url) => {
        await fetch(new URL('nope', url));
      });
    });

    const entry = entries.find((e) => e['message'] === 'GET /nope 404');
    expect(entry?.['level']).toBe('warn');
    expect(entry?.['context']).toBe('(unmatched).(none)');
  });

  it('logs nothing when turned off', async () => {
    const entries = await captured(async () => {
      await withApp(
        async (_app, url) => {
          await fetch(new URL('things', url));
        },
        { requestLogging: false },
      );
    });

    expect(entries.filter((e) => e['statusCode'] !== undefined)).toEqual([]);
  });

  it('honours ignore and the body switches', async () => {
    const entries = await captured(async () => {
      await withApp(
        async (_app, url) => {
          await fetch(new URL('things', url));
          await fetch(new URL('things/boom', url));
        },
        { requestLogging: { ignore: ['/things'], responseBody: false } },
      );
    });

    expect(
      entries.find((e) => e['message'] === 'GET /things 200'),
    ).toBeUndefined();
    const boom = entries.find((e) => e['message'] === 'GET /things/boom 418');
    expect(boom).toBeDefined();
    expect(boom?.['responseBody']).toBeUndefined();
  });

  it('binds RequestContext by default, so an app can use it directly', async () => {
    await withApp(
      async (app) => {
        const context = app.get(RequestContext);
        const seen = context.runWithContext({ requestId: 'r1' }, () =>
          context.getContext(),
        );
        expect(seen['requestId']).toBe('r1');
        expect(context.getContext()).toEqual({});
      },
      { requestLogging: false },
    );
  });
});
