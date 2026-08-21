import type { BunRequest } from 'bun';
import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import { Controller, Get, Post } from '../route/decorators.js';
import { UseGuards } from '../route/metadata.js';
import type {
  Input,
  StandardSchemaResult,
  StandardSchemaV1,
} from '../route/schema.js';
import type { RouteContext } from './context.js';
import { HttpError } from './errors.js';
import { HttpFactory, type HttpApp } from './factory.js';
import type { Middleware, Next } from './middleware.js';
import { REQUEST_ID_HEADER } from './request-id.js';
import { HttpStatusCode } from './status.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The same shape `request-logging.test.ts` reads, and it silences the run. */
const captured = async (
  run: () => Promise<void>,
): Promise<Record<string, unknown>[]> => {
  const lines: string[] = [];
  const { log, error } = console;
  const record = (...args: unknown[]): void => {
    lines.push(...args.map(String).join(' ').split('\n'));
  };
  console.log = record;
  console.error = record;
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

const Note: StandardSchemaV1<unknown, { text: string }> = {
  '~standard': {
    version: 1,
    vendor: 'test',
    validate: (value): StandardSchemaResult<{ text: string }> => {
      const text = (value as Record<string, unknown> | null)?.['text'];
      return typeof text === 'string'
        ? { value: { text } }
        : { issues: [{ message: 'text must be a string', path: ['text'] }] };
    },
  },
};

const createNote = { body: Note } as const;

class Denies implements Middleware {
  handle(_req: BunRequest, _ctx: RouteContext, _next: Next): Promise<Response> {
    throw new HttpError(HttpStatusCode.UNAUTHORIZED, 'No credentials');
  }
}

@Controller('notes')
class NotesController {
  @Post('/', createNote)
  create(input: Input<typeof createNote>): { text: string } {
    return input.body;
  }

  @Get('/guarded')
  @UseGuards(Denies)
  guarded(): never {
    throw new Error('the guard answers first');
  }

  @Get('/broken')
  broken(): never {
    throw new Error('unhandled');
  }
}

@Module({ controllers: [NotesController] })
class NotesModule {}

const withApp = async (
  run: (app: HttpApp, url: string) => Promise<void>,
  options: Parameters<typeof HttpFactory.create>[1] = {},
): Promise<void> => {
  const app = await HttpFactory.create(NotesModule, options);
  const url = await app.listen(0);
  try {
    await run(app, url);
  } finally {
    await app.shutdown();
  }
};

/**
 * One request, one header. The holder keeps TypeScript's narrowing from the
 * initialiser, the way the request logging suite's does.
 */
const idOf = async (
  path: string,
  init: RequestInit = {},
  options: Parameters<typeof HttpFactory.create>[1] = {},
): Promise<{
  header?: string | undefined;
  entries: Record<string, unknown>[];
}> => {
  const seen: { header?: string | undefined } = {};
  const entries = await captured(async () => {
    await withApp(async (_app, url) => {
      const response = await fetch(new URL(path, url), init);
      seen.header = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
    }, options);
  });
  return { ...seen, entries };
};

const posted = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/**
 * The error mapper runs outside the middleware chain and builds a fresh
 * `Response`, so every one of these went out with no id on it - the responses a
 * caller most needs in order to find the line the logger wrote for them.
 */
describe('the request id on a failure', () => {
  it('is on a status a guard threw', async () => {
    const { header } = await idOf('notes/guarded');
    expect(header).toMatch(UUID);
  });

  it('is on a validation 400', async () => {
    const { header } = await idOf('notes', posted({ text: 7 }));
    expect(header).toMatch(UUID);
  });

  it('is on a mapped 500, and matches the entry that recorded it', async () => {
    const { header, entries } = await idOf('notes/broken');
    expect(header).toMatch(UUID);
    const entry = entries.find(
      (line) => line['message'] === 'GET /notes/broken 500',
    );
    expect(entry?.['requestId']).toBe(header);
  });

  it('is on an unmatched path', async () => {
    const { header } = await idOf('nothing-here');
    expect(header).toMatch(UUID);
  });

  it('honours an inbound uuid', async () => {
    const given = '3f8c1b0e-9a4d-4c2f-8e11-6b7a2d5c9f03';
    const { header } = await idOf('notes/broken', {
      headers: { [REQUEST_ID_HEADER]: given },
    });
    expect(header).toBe(given);
  });

  it('replaces an inbound id that is not a uuid', async () => {
    const { header } = await idOf('notes/broken', {
      headers: { [REQUEST_ID_HEADER]: 'MY-OWN-ID' },
    });
    expect(header).not.toBe('MY-OWN-ID');
    expect(header).toMatch(UUID);
  });

  /** Nothing minted an id, so there is none to put on the failure either. */
  it('is absent when request logging is off', async () => {
    const mapped = await idOf('notes/broken', {}, { requestLogging: false });
    expect(mapped.header).toBeUndefined();
    const missed = await idOf('nothing-here', {}, { requestLogging: false });
    expect(missed.header).toBeUndefined();
  });

  it('is absent on an ignored path, inbound or not', async () => {
    const options = { requestLogging: { ignore: ['/notes/broken'] } };
    const { header } = await idOf('notes/broken', {}, options);
    expect(header).toBeUndefined();
    const echoed = await idOf(
      'notes/broken',
      {
        headers: {
          [REQUEST_ID_HEADER]: '3f8c1b0e-9a4d-4c2f-8e11-6b7a2d5c9f03',
        },
      },
      options,
    );
    expect(echoed.header).toBeUndefined();
  });
});
