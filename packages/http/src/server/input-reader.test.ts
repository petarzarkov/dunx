import type { BunRequest } from 'bun';
import { describe, expect, it } from 'bun:test';
import { Module } from '@dunx/core';
import { Controller, Post } from '../route/decorators.js';
import type {
  Input,
  RouteSchemas,
  StandardSchemaResult,
  StandardSchemaV1,
} from '../route/schema.js';
import { ValidationError } from './errors.js';
import { HttpFactory, type HttpApp } from './factory.js';
import { buildInputReader } from './input.js';
import { HttpStatusCode } from './status.js';

/**
 * The reader itself, rather than the typed input a route ends up with, which is in
 * `input.test.ts`: which content types it turns into a body, and what it allocates
 * doing it. A route that declares no schema must pay nothing for the feature
 * existing, and a synchronous validator must not cost a promise.
 */

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

const createNote = { body: Note } as const;
const textNote = { body: Text } as const;
const formNote = { body: Fields } as const;

@Controller('notes')
class NotesController {
  @Post('/', createNote)
  create(input: Input<typeof createNote>): { text: string } {
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

/**
 * Rejects everything, which is how "a response schema documents and never runs" is
 * asserted rather than assumed: if anything ever validated against it, the reader
 * below could not succeed.
 */
const Rejecting = schema<never>(() => ({
  issues: [{ message: 'a response schema must never be validated' }],
}));

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

describe('buildInputReader()', () => {
  const request = new Request('http://test/x') as BunRequest;

  it('is synchronous and allocation-only when nothing is declared', () => {
    const read = buildInputReader(undefined);

    // No promise, so a schema-less route pays nothing for the feature existing.
    expect(read(request)).toEqual({ req: request });
    expect(read({} as BunRequest)).not.toBeInstanceOf(Promise);
  });

  it('builds no reader for a response schema, which is documentation only', () => {
    const read = buildInputReader({ response: { 200: Rejecting } });

    expect(read(request)).toEqual({ req: request });
    expect(read(request)).not.toBeInstanceOf(Promise);
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
