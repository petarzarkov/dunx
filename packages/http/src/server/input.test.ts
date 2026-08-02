import type { BunRequest } from 'bun';
import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import { Controller, Get, Post, Put } from '../route/decorators.js';
import type {
  Input,
  RouteSchemas,
  StandardSchemaResult,
  StandardSchemaV1,
} from '../route/schema.js';
import { HttpError, ValidationError } from './errors.js';
import { HttpFactory, type HttpApp } from './factory.js';
import { buildInputReader } from './input.js';
import { HttpStatusCode } from './status.js';

/** A Standard Schema by hand - the point being that no dependency is involved. */
const schema = <T>(
  validate: (
    value: unknown,
  ) => StandardSchemaResult<T> | Promise<StandardSchemaResult<T>>,
): StandardSchemaV1<unknown, T> => ({
  '~standard': { version: 1, vendor: 'test', validate },
});

const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;

const Note = schema<{ text: string }>((value) => {
  const text = field(value, 'text');
  return typeof text === 'string'
    ? { value: { text } }
    : { issues: [{ message: 'text must be a string', path: ['text'] }] };
});

// Valibot-shaped path segments - objects with a `key`, not bare keys.
const Segmented = schema<{ text: string }>((value) => {
  const text = field(value, 'text');
  return typeof text === 'string'
    ? { value: { text } }
    : {
        issues: [
          { message: 'expected a string', path: [{ key: 'note' }, { key: 0 }] },
        ],
      };
});

const Slow = schema<{ text: string }>(async (value) => {
  await Bun.sleep(1);
  const text = field(value, 'text');
  return typeof text === 'string'
    ? { value: { text: text.toUpperCase() } }
    : { issues: [{ message: 'text must be a string' }] };
});

const Text = schema<string>((value) =>
  typeof value === 'string'
    ? { value }
    : { issues: [{ message: 'expected a text body' }] },
);

const Fields = schema<{ tags: string[]; file: string | undefined }>((value) => {
  const tags = field(value, 'tags');
  const file = field(value, 'file');
  return {
    value: {
      tags: Array.isArray(tags) ? (tags as string[]) : [String(tags)],
      file: file instanceof File ? file.name : undefined,
    },
  };
});

const Paging = schema<{ page: number; tags: string[] }>((value) => {
  const page = Number(field(value, 'page'));
  const tags = field(value, 'tags');
  return Number.isInteger(page)
    ? {
        value: {
          page,
          tags: Array.isArray(tags) ? (tags as string[]) : [],
        },
      }
    : { issues: [{ message: 'page must be an integer', path: ['page'] }] };
});

const NumericId = schema<{ id: number }>((value) => {
  const id = Number(field(value, 'id'));
  return Number.isInteger(id)
    ? { value: { id } }
    : { issues: [{ message: 'id must be numeric', path: ['id'] }] };
});

const createNote = { body: Note } as const;
const acceptNote = { body: Note, status: HttpStatusCode.ACCEPTED } as const;
const segmented = { body: Segmented } as const;
const slowNote = { body: Slow } as const;
const textNote = { body: Text } as const;
const formNote = { body: Fields } as const;
const searchNotes = { query: Paging } as const;
const oneNote = { params: NumericId } as const;
const replaceNote = { body: Note, params: NumericId } as const;

@Controller('notes')
class NotesController {
  @Post('/', createNote)
  create(input: Input<typeof createNote>): { text: string } {
    return { text: input.body.text };
  }

  @Post('/accepted', acceptNote)
  accepted(input: Input<typeof acceptNote>): { text: string } {
    return { text: input.body.text };
  }

  @Post('/segmented', segmented)
  segmented(input: Input<typeof segmented>): { text: string } {
    return { text: input.body.text };
  }

  @Post('/slow', slowNote)
  slow(input: Input<typeof slowNote>): { text: string } {
    return { text: input.body.text };
  }

  @Post('/text', textNote)
  text(input: Input<typeof textNote>): { length: number } {
    return { length: input.body.length };
  }

  @Post('/form', formNote)
  form(input: Input<typeof formNote>): {
    tags: string[];
    file: string | undefined;
  } {
    return { tags: input.body.tags, file: input.body.file };
  }

  @Post('/raw')
  raw(input: Input<RouteSchemas>): { media: string | null } {
    return { media: input.req.headers.get('content-type') };
  }

  @Post('/escape', createNote)
  escape(input: Input<typeof createNote>): Response {
    return new Response(input.body.text, { status: 418 });
  }

  @Post('/silent', createNote)
  silent(_input: Input<typeof createNote>): undefined {
    return undefined;
  }

  @Get('/search', searchNotes)
  search(input: Input<typeof searchNotes>): { page: number; tags: string[] } {
    return { page: input.query.page, tags: input.query.tags };
  }

  @Get('/nothing')
  nothing(): null {
    return null;
  }

  @Get('/boom')
  boom(): never {
    throw new HttpError(HttpStatusCode.CONFLICT, 'already exists');
  }

  @Get('/:id', oneNote)
  one(input: Input<typeof oneNote>): { id: number } {
    return { id: input.params.id };
  }

  @Put('/:id', replaceNote)
  replace(input: Input<typeof replaceNote>): { id: number; text: string } {
    return { id: input.params.id, text: input.body.text };
  }
}

@Module({ controllers: [NotesController] })
class AppModule {}

const withApp = async (
  run: (app: HttpApp, url: string) => Promise<void>,
): Promise<void> => {
  const app = await HttpFactory.create(AppModule);
  const url = await app.listen(0);
  try {
    await run(app, url);
  } finally {
    await app.shutdown();
  }
};

const json = (
  url: string,
  path: string,
  body: unknown,
  method: 'POST' | 'PUT' = 'POST',
): Promise<Response> =>
  fetch(new URL(path, url), {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('typed route input', () => {
  it('parses, validates and hands the handler a typed body', async () => {
    await withApp(async (_app, url) => {
      const response = await json(url, 'notes', { text: 'ship it' });

      expect(response.status).toBe(HttpStatusCode.CREATED);
      expect(await response.json()).toEqual({ text: 'ship it' });
    });
  });

  it('reports validation issues as a 400 carrying message and path', async () => {
    await withApp(async (_app, url) => {
      const response = await json(url, 'notes', { text: 7 });

      expect(response.status).toBe(HttpStatusCode.BAD_REQUEST);
      expect(await response.json()).toEqual({
        error: 'Invalid body',
        status: 400,
        issues: [{ message: 'text must be a string', path: 'text' }],
      });
    });
  });

  it('flattens object path segments the way Valibot emits them', async () => {
    await withApp(async (_app, url) => {
      const response = await json(url, 'notes/segmented', {});

      expect(await response.json()).toEqual({
        error: 'Invalid body',
        status: 400,
        issues: [{ message: 'expected a string', path: 'note.0' }],
      });
    });
  });

  it('omits the path when the issue is at the root', async () => {
    await withApp(async (_app, url) => {
      const response = await json(url, 'notes/slow', {});

      expect(await response.json()).toEqual({
        error: 'Invalid body',
        status: 400,
        issues: [{ message: 'text must be a string' }],
      });
    });
  });

  it('awaits a promise-returning validate', async () => {
    await withApp(async (_app, url) => {
      const response = await json(url, 'notes/slow', { text: 'quiet' });

      expect(await response.json()).toEqual({ text: 'QUIET' });
    });
  });

  it('validates query from searchParams, keeping repeated keys', async () => {
    await withApp(async (_app, url) => {
      const response = await fetch(
        new URL('notes/search?page=2&tags=a&tags=b', url),
      );

      expect(response.status).toBe(HttpStatusCode.OK);
      expect(await response.json()).toEqual({ page: 2, tags: ['a', 'b'] });

      const bad = await fetch(new URL('notes/search?page=nope', url));
      expect(bad.status).toBe(HttpStatusCode.BAD_REQUEST);
      expect(await bad.json()).toEqual({
        error: 'Invalid query',
        status: 400,
        issues: [{ message: 'page must be an integer', path: 'page' }],
      });
    });
  });

  it('validates params from req.params', async () => {
    await withApp(async (_app, url) => {
      expect(await (await fetch(new URL('notes/42', url))).json()).toEqual({
        id: 42,
      });

      const bad = await fetch(new URL('notes/abc', url));
      expect(bad.status).toBe(HttpStatusCode.BAD_REQUEST);
      expect(await bad.json()).toEqual({
        error: 'Invalid params',
        status: 400,
        issues: [{ message: 'id must be numeric', path: 'id' }],
      });
    });
  });

  it('validates body and params together', async () => {
    await withApp(async (_app, url) => {
      const response = await json(url, 'notes/7', { text: 'edited' }, 'PUT');

      expect(response.status).toBe(HttpStatusCode.OK);
      expect(await response.json()).toEqual({ id: 7, text: 'edited' });
    });
  });
});

describe('body parsing by content-type', () => {
  it('turns a malformed JSON body into a 400, not a 500', async () => {
    await withApp(async (_app, url) => {
      const response = await fetch(new URL('notes', url), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"text":',
      });

      expect(response.status).toBe(HttpStatusCode.BAD_REQUEST);
      expect(await response.json()).toEqual({
        error: 'Malformed application/json body',
        status: 400,
      });
    });
  });

  it('reads application/x-www-form-urlencoded, repeated keys included', async () => {
    await withApp(async (_app, url) => {
      const response = await fetch(new URL('notes/form', url), {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams([
          ['tags', 'a'],
          ['tags', 'b'],
        ]),
      });

      expect(await response.json()).toEqual({ tags: ['a', 'b'] });
    });
  });

  it('reads multipart/form-data, files intact', async () => {
    await withApp(async (_app, url) => {
      const form = new FormData();
      form.append('tags', 'a');
      form.append('file', new File(['hi'], 'note.txt', { type: 'text/plain' }));

      const response = await fetch(new URL('notes/form', url), {
        method: 'POST',
        body: form,
      });

      expect(await response.json()).toEqual({
        tags: ['a'],
        file: 'note.txt',
      });
    });
  });

  it('reads text/* as a string', async () => {
    await withApp(async (_app, url) => {
      const response = await fetch(new URL('notes/text', url), {
        method: 'POST',
        headers: { 'content-type': 'text/plain;charset=utf-8' },
        body: 'four',
      });

      expect(await response.json()).toEqual({ length: 4 });
    });
  });

  it('rejects a content-type it cannot parse with a 415', async () => {
    await withApp(async (_app, url) => {
      const response = await fetch(new URL('notes', url), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: 'binary',
      });

      expect(response.status).toBe(HttpStatusCode.UNSUPPORTED_MEDIA_TYPE);
      expect(((await response.json()) as { error: string }).error).toMatch(
        /^Unsupported content type "application\/octet-stream"/,
      );
    });
  });

  it('never touches the body of a route that declares none', async () => {
    await withApp(async (_app, url) => {
      const response = await fetch(new URL('notes/raw', url), {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: 'binary',
      });

      // Would be a 415 if the framework had tried to parse it.
      expect(response.status).toBe(HttpStatusCode.CREATED);
      expect(await response.json()).toEqual({
        media: 'application/octet-stream',
      });
    });
  });
});

describe('response wrapping', () => {
  it('defaults to 201 for POST and 200 for every other verb', async () => {
    await withApp(async (_app, url) => {
      expect((await json(url, 'notes', { text: 'a' })).status).toBe(201);
      expect((await fetch(new URL('notes/42', url))).status).toBe(200);
      expect((await json(url, 'notes/7', { text: 'b' }, 'PUT')).status).toBe(
        200,
      );
    });
  });

  it('lets options.status win over the verb default', async () => {
    await withApp(async (_app, url) => {
      const response = await json(url, 'notes/accepted', { text: 'later' });

      expect(response.status).toBe(HttpStatusCode.ACCEPTED);
      expect(await response.json()).toEqual({ text: 'later' });
    });
  });

  it('passes a returned Response through untouched', async () => {
    await withApp(async (_app, url) => {
      const response = await json(url, 'notes/escape', { text: 'raw' });

      expect(response.status).toBe(418);
      expect(await response.text()).toBe('raw');
    });
  });

  it('answers 204 with no body for undefined and for null', async () => {
    await withApp(async (_app, url) => {
      const silent = await json(url, 'notes/silent', { text: 'x' });
      expect(silent.status).toBe(HttpStatusCode.NO_CONTENT);
      expect(await silent.text()).toBe('');

      const nothing = await fetch(new URL('notes/nothing', url));
      expect(nothing.status).toBe(HttpStatusCode.NO_CONTENT);
      expect(await nothing.text()).toBe('');
    });
  });

  it('still maps a thrown HttpError through onError', async () => {
    await withApp(async (_app, url) => {
      const response = await fetch(new URL('notes/boom', url));

      expect(response.status).toBe(HttpStatusCode.CONFLICT);
      expect(await response.json()).toEqual({
        error: 'already exists',
        status: 409,
      });
    });
  });
});

describe('buildInputReader()', () => {
  const request = new Request('http://test/x') as BunRequest;

  it('is synchronous and allocation-only when nothing is declared', () => {
    const read = buildInputReader(undefined);

    // No promise, so a schema-less route pays nothing for the feature existing.
    expect(read(request)).toEqual({ req: request });
    expect(read({} as BunRequest)).not.toBeInstanceOf(Promise);
  });

  it('stays synchronous for params and query against a sync validator', () => {
    // Standard Schema *permits* a promise; awaiting one that never comes cost an
    // async frame and a tick per schema. Neither of these allocates one now.
    const params = buildInputReader({
      params: schema<number>((v) => ({ value: Number(v) })),
    });
    const query = buildInputReader({
      query: schema<number>(() => ({ value: 1 })),
    });

    expect(params(request)).not.toBeInstanceOf(Promise);
    expect(query(request)).not.toBeInstanceOf(Promise);
    expect(params(request)).toEqual({ req: request, params: NaN });
  });

  it('slices the query string exactly as `new URL().searchParams` did', () => {
    // The reader stopped parsing the whole URL to reach `searchParams`, which was
    // ~1000 of the ~1500 ns a query route cost. These are the cases where a slice
    // could differ from a parse.
    const seen = schema<unknown>((value) => ({ value }));
    const read = buildInputReader({ query: seen });
    const queryOf = (url: string): unknown =>
      (read(new Request(url) as BunRequest) as { query: unknown }).query;

    for (const url of [
      'http://test/x',
      'http://test/x?',
      'http://test/x?a=1',
      'http://test/x?tag=a&tag=b&tag=c',
      'http://test/x?a=one+two&b=%2Ffoo%3D',
      'http://test/x?flag&a=',
      'http://test/x?a=1#frag',
      'http://test/x?a=1&b=2#a=nope',
      'http://test/x#only-a-fragment',
      'http://test/x?a=%3F%23',
    ]) {
      const grouped: Record<string, unknown> = {};
      for (const [key, value] of new URL(url).searchParams) {
        const existing = grouped[key];
        if (existing === undefined) grouped[key] = value;
        else if (Array.isArray(existing)) existing.push(value);
        else grouped[key] = [existing, value];
      }
      expect(queryOf(url)).toEqual(grouped);
    }
  });

  it('adopts an async validator, and reports its issues the same way', async () => {
    const read = buildInputReader({ params: Slow });
    const pending = read(request);
    expect(pending).toBeInstanceOf(Promise);

    let caught: unknown;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).issues).toEqual([
      { message: 'text must be a string' },
    ]);
  });

  it('resolves the declared schemas once, at build time', async () => {
    let calls = 0;
    const counted = schema<number>((value) => {
      calls += 1;
      return { value: Number(value) };
    });
    const read = buildInputReader({ params: counted });

    expect(calls).toBe(0);
    await read(request);
    await read(request);
    expect(calls).toBe(2);
  });
});
